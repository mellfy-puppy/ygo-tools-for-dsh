'use strict';

function createSnapshotAccelRuntimeApi(deps) {
  const {
    Buffer,
    fs,
    koffi,
    SNAPSHOT_ACCEL_DLL_PATH,
    MODERN_SNAPSHOT_GPU_MIN_BYTES,
    MODERN_SNAPSHOT_PAGE_SIZE,
    startProfileTimer,
    endProfileTimer,
    snapshotState,
  } = deps;

  function pageDiffers(currentHeap, rootMemory, start, end) {
    if (start >= rootMemory.byteLength) return true;
    const safeEnd = Math.min(end, rootMemory.byteLength);
    for (let index = start; index < safeEnd; index += 1) {
      if (currentHeap[index] !== rootMemory[index]) return true;
    }
    return end > rootMemory.byteLength;
  }

  function ensureScratchBuffer(buffer, minByteLength) {
    if (Buffer.isBuffer(buffer) && buffer.byteLength >= minByteLength) {
      return buffer;
    }
    return Buffer.allocUnsafe(Math.max(4, minByteLength));
  }

  function isEnabledEnv(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
  }

  function readPositiveIntEnv(name, fallback) {
    const parsed = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function alignUp(value, alignment) {
    if (!Number.isSafeInteger(value) || value <= 0) return 0;
    if (!Number.isSafeInteger(alignment) || alignment <= 1) return value;
    return Math.ceil(value / alignment) * alignment;
  }

  function getScratchBufferView(scratch, key, source, byteLength) {
    const safeLength = Math.max(0, byteLength >>> 0);
    const cached = scratch[key];
    if (cached &&
        cached.buffer === source.buffer &&
        cached.byteOffset === source.byteOffset &&
        cached.byteLength === safeLength) {
      return cached.view;
    }
    const view = Buffer.from(source.buffer, source.byteOffset, safeLength);
    scratch[key] = {
      buffer: source.buffer,
      byteOffset: source.byteOffset,
      byteLength: safeLength,
      view,
    };
    return view;
  }

  function normalizePackedBackendMode(value) {
    const mode = String(value ?? '').trim().toLowerCase();
    if (['0', 'false', 'off', 'none', 'disabled'].includes(mode)) return 'off';
    if (['1', 'true', 'host', 'packed'].includes(mode)) return 'host';
    if (['device', 'cuda-device', 'gpu-device'].includes(mode)) return 'device';
    if (['auto', 'best'].includes(mode)) return 'auto';
    return null;
  }

  function resolvePackedGpuBackend(snapshotAccel) {
    if (!snapshotAccel || process.env.COMBO_SNAPSHOT_ACCEL_DISABLE_PACKED === '1') {
      return null;
    }
    const explicitMode = normalizePackedBackendMode(process.env.COMBO_SNAPSHOT_ACCEL_PACK_MODE);
    const legacyPackedEnabled = process.env.COMBO_SNAPSHOT_ACCEL_PACKED === '1';
    const legacyDeviceRequested = process.env.COMBO_SNAPSHOT_ACCEL_DEVICE_PACK === '1';
    const mode = explicitMode ?? (
      legacyPackedEnabled
        ? legacyDeviceRequested ? 'device' : 'host'
        : 'off'
    );
    if (mode === 'off') return null;
    if (mode === 'device') {
      return typeof snapshotAccel.detectChangedPagesPackedDevice === 'function'
        ? { mode: 'device', fn: snapshotAccel.detectChangedPagesPackedDevice }
        : null;
    }
    if (mode === 'host') {
      return typeof snapshotAccel.detectChangedPagesPacked === 'function'
        ? { mode: 'host', fn: snapshotAccel.detectChangedPagesPacked }
        : null;
    }
    if (mode === 'auto') {
      if (typeof snapshotAccel.detectChangedPagesPacked === 'function') {
        return { mode: 'host', fn: snapshotAccel.detectChangedPagesPacked };
      }
      return typeof snapshotAccel.detectChangedPagesPackedDevice === 'function'
        ? { mode: 'device', fn: snapshotAccel.detectChangedPagesPackedDevice }
        : null;
    }
    return null;
  }

  function normalizeOffsetBackendMode(value) {
    const mode = String(value ?? '').trim().toLowerCase();
    if (['', 'auto', 'best', 'default'].includes(mode)) return 'auto';
    if (['0', 'false', 'h2d', 'device', 'device-copy'].includes(mode)) return 'h2d';
    if (['prefix', 'prefixed', 'count-prefixed', 'single-d2h'].includes(mode)) return 'prefixed';
    if (['mapped', 'mapped-current', 'zero-copy'].includes(mode)) return 'mapped';
    return null;
  }

  function resolveOffsetGpuBackend(snapshotAccel) {
    if (!snapshotAccel) return null;
    const mode = normalizeOffsetBackendMode(process.env.COMBO_SNAPSHOT_ACCEL_OFFSET_MODE);
    if (mode === 'auto' && typeof snapshotAccel.detectChangedPagesPrefixed === 'function') {
      return { mode: 'prefixed', fn: snapshotAccel.detectChangedPagesPrefixed };
    }
    if (mode === 'prefixed') {
      return typeof snapshotAccel.detectChangedPagesPrefixed === 'function'
        ? { mode: 'prefixed', fn: snapshotAccel.detectChangedPagesPrefixed }
        : null;
    }
    if (mode === 'mapped') {
      return typeof snapshotAccel.detectChangedPagesMappedCurrent === 'function'
        ? { mode: 'mapped', fn: snapshotAccel.detectChangedPagesMappedCurrent }
        : null;
    }
    return typeof snapshotAccel.detectChangedPages === 'function'
      ? { mode: 'h2d', fn: snapshotAccel.detectChangedPages }
      : null;
  }

  function findGuardedPrefixDiffWindow(currentHeap, rootMemory, targetByteLength, pageSize) {
    if (!isEnabledEnv(process.env.COMBO_SNAPSHOT_ACCEL_GUARDED_PREFIX)) return null;
    if (
      !(currentHeap instanceof Uint8Array) ||
      !(rootMemory instanceof Uint8Array) ||
      !Number.isSafeInteger(targetByteLength) ||
      targetByteLength <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize <= 0 ||
      currentHeap.byteLength < targetByteLength ||
      rootMemory.byteLength < targetByteLength
    ) {
      return null;
    }
    const guardStartedAt = startProfileTimer();
    try {
      const currentBytes = Buffer.from(currentHeap.buffer, currentHeap.byteOffset, targetByteLength);
      const rootBytes = Buffer.from(rootMemory.buffer, rootMemory.byteOffset, targetByteLength);
      let suffixStart = targetByteLength;
      for (
        let start = Math.floor(Math.max(0, targetByteLength - 1) / pageSize) * pageSize;
        start >= 0;
        start -= pageSize
      ) {
        const end = Math.min(start + pageSize, targetByteLength);
        if (currentBytes.compare(rootBytes, start, end, start, end) !== 0) break;
        suffixStart = start;
      }
      const skippedBytes = targetByteLength - suffixStart;
      const minSkippedBytes = readPositiveIntEnv(
        'COMBO_SNAPSHOT_ACCEL_GUARDED_PREFIX_MIN_TAIL_BYTES',
        readPositiveIntEnv('COMBO_SNAPSHOT_ACCEL_GUARDED_PREFIX_MIN_TAIL_PAGES', 8) * pageSize,
      );
      if (skippedBytes < minSkippedBytes) return null;
      const byteLength = Math.min(targetByteLength, alignUp(suffixStart, pageSize));
      if (byteLength >= targetByteLength) return null;
      return {
        byteLength,
        skippedBytes,
      };
    } finally {
      endProfileTimer('snapshotAccel.guardedPrefix.guard', guardStartedAt);
    }
  }

  function bindOptionalNative(lib, signature) {
    try {
      return lib.func(signature);
    } catch {
      return null;
    }
  }

  function loadSnapshotAccel() {
    const cached = snapshotState.getSnapshotAccelState();
    if (cached !== undefined) return cached;
    if (snapshotState.getSnapshotAccelMode() === 'cpu') {
      snapshotState.setSnapshotAccelState(null);
      return snapshotState.getSnapshotAccelState();
    }
    if (!koffi || !fs.existsSync(SNAPSHOT_ACCEL_DLL_PATH)) {
      snapshotState.setSnapshotAccelState(null);
      return snapshotState.getSnapshotAccelState();
    }
    try {
      const lib = koffi.load(SNAPSHOT_ACCEL_DLL_PATH);
      const rawDetectChangedPages = lib.func(
        'int cs_detect_changed_pages(const void* current, uint32 current_len, const void* root, uint32 root_len, uint32 page_size, void* out_offsets, uint32 max_offsets)',
      );
      let rawDetectChangedPagesPrefixed = null;
      try {
        rawDetectChangedPagesPrefixed = lib.func(
          'int cs_detect_changed_pages_prefixed(const void* current, uint32 current_len, const void* root, uint32 root_len, uint32 page_size, void* out_count_and_offsets, uint32 max_offsets)',
        );
      } catch {
        rawDetectChangedPagesPrefixed = null;
      }
      let rawDetectChangedPagesMappedCurrent = null;
      try {
        rawDetectChangedPagesMappedCurrent = lib.func(
          'int cs_detect_changed_pages_mapped_current(const void* current, uint32 current_len, const void* root, uint32 root_len, uint32 page_size, void* out_offsets, uint32 max_offsets)',
        );
      } catch {
        rawDetectChangedPagesMappedCurrent = null;
      }
      const rawDetectChangedPagesPacked = lib.func(
        'int cs_detect_changed_pages_packed(const void* current, uint32 current_len, const void* root, uint32 root_len, uint32 page_size, void* out_offsets, uint32 max_offsets, void* out_data, uint32 out_data_len, void* out_packed_bytes)',
      );
      let rawDetectChangedPagesPackedDevice = null;
      try {
        rawDetectChangedPagesPackedDevice = lib.func(
          'int cs_detect_changed_pages_packed_device(const void* current, uint32 current_len, const void* root, uint32 root_len, uint32 page_size, void* out_offsets, uint32 max_offsets, void* out_data, uint32 out_data_len, void* out_packed_bytes)',
        );
      } catch {
        rawDetectChangedPagesPackedDevice = null;
      }
      const cudaAvailable = lib.func('int cs_cuda_available(void)');
      const rawReleaseBuffers = lib.func('void cs_release_buffers(void)');
      // 诊断统计接口（可选；老 dll 不存在时不影响）
      const rawEnableStats = bindOptionalNative(lib, 'void cs_enable_stats(int enabled)');
      const rawDumpStats = bindOptionalNative(lib, 'void cs_dump_stats(void* out_buf)');
      const createContext = bindOptionalNative(lib, 'void* cs_create_context(void)');
      const destroyContext = bindOptionalNative(lib, 'void cs_destroy_context(void* handle)');
      const contextDetectChangedPages = bindOptionalNative(
        lib,
        'int cs_context_detect_changed_pages(void* handle, const void* current, uint32 current_len, const void* root, uint32 root_len, uint32 page_size, void* out_offsets, uint32 max_offsets)',
      );
      const contextDetectChangedPagesPrefixed = bindOptionalNative(
        lib,
        'int cs_context_detect_changed_pages_prefixed(void* handle, const void* current, uint32 current_len, const void* root, uint32 root_len, uint32 page_size, void* out_count_and_offsets, uint32 max_offsets)',
      );
      const contextDetectChangedPagesMappedCurrent = bindOptionalNative(
        lib,
        'int cs_context_detect_changed_pages_mapped_current(void* handle, const void* current, uint32 current_len, const void* root, uint32 root_len, uint32 page_size, void* out_offsets, uint32 max_offsets)',
      );
      const contextDetectChangedPagesPacked = bindOptionalNative(
        lib,
        'int cs_context_detect_changed_pages_packed(void* handle, const void* current, uint32 current_len, const void* root, uint32 root_len, uint32 page_size, void* out_offsets, uint32 max_offsets, void* out_data, uint32 out_data_len, void* out_packed_bytes)',
      );
      const contextDetectChangedPagesPackedDevice = bindOptionalNative(
        lib,
        'int cs_context_detect_changed_pages_packed_device(void* handle, const void* current, uint32 current_len, const void* root, uint32 root_len, uint32 page_size, void* out_offsets, uint32 max_offsets, void* out_data, uint32 out_data_len, void* out_packed_bytes)',
      );
      const contextEnableStats = bindOptionalNative(lib, 'void cs_context_enable_stats(void* handle, int enabled)');
      const contextDumpStats = bindOptionalNative(lib, 'void cs_context_dump_stats(void* handle, void* out_buf)');
      if ((cudaAvailable?.() ?? 0) <= 0) {
        if (snapshotState.getSnapshotAccelMode() === 'gpu') {
          throw new Error('GPU snapshot accelerator requested but no CUDA device is available');
        }
        snapshotState.setSnapshotAccelState(null);
        return snapshotState.getSnapshotAccelState();
      }
      const hasContextApi = typeof createContext === 'function' &&
        typeof destroyContext === 'function' &&
        typeof contextDetectChangedPages === 'function' &&
        process.env.COMBO_SNAPSHOT_ACCEL_DISABLE_CONTEXT !== '1';
      const contextHandle = hasContextApi ? createContext() : null;
      let contextReleased = false;
      const withContext = (fn) => (
        contextHandle && typeof fn === 'function'
          ? (...args) => fn(contextHandle, ...args)
          : null
      );
      const releaseBuffers = () => {
        if (contextHandle) {
          if (contextReleased) return;
          contextReleased = true;
          destroyContext(contextHandle);
          return;
        }
        rawReleaseBuffers();
      };
      const enableStats = contextHandle && typeof contextEnableStats === 'function'
        ? (enabled) => contextEnableStats(contextHandle, enabled)
        : rawEnableStats;
      const dumpStats = contextHandle && typeof contextDumpStats === 'function'
        ? (outBuf) => {
            if (contextReleased) return;
            contextDumpStats(contextHandle, outBuf);
          }
        : rawDumpStats;

      snapshotState.setSnapshotAccelState({
        lib,
        nativeContextHandle: contextHandle,
        detectChangedPages: withContext(contextDetectChangedPages) ?? rawDetectChangedPages,
        detectChangedPagesPrefixed: withContext(contextDetectChangedPagesPrefixed) ?? rawDetectChangedPagesPrefixed,
        detectChangedPagesMappedCurrent: withContext(contextDetectChangedPagesMappedCurrent) ?? rawDetectChangedPagesMappedCurrent,
        detectChangedPagesPacked: withContext(contextDetectChangedPagesPacked) ?? rawDetectChangedPagesPacked,
        detectChangedPagesPackedDevice: withContext(contextDetectChangedPagesPackedDevice) ?? rawDetectChangedPagesPackedDevice,
        cudaAvailable,
        releaseBuffers,
        enableStats,
        dumpStats,
        scratch: {
          offsets: null,
          countAndOffsets: null,
          pageData: null,
          packedBytes: Buffer.allocUnsafe(4),
        },
      });
      // 若用户开启 COMBO_SNAPSHOT_ACCEL_STATS=1，则启用并在进程退出前 dump 一次。
      if (typeof enableStats === 'function' &&
          typeof dumpStats === 'function' &&
          process.env.COMBO_SNAPSHOT_ACCEL_STATS === '1') {
        enableStats(1);
        const dumpBuf = Buffer.alloc(16 * 8);
        const dumpOnce = () => {
          try {
            dumpStats(dumpBuf);
            const calls = Number(dumpBuf.readBigUInt64LE(0));
            const mapped = Number(dumpBuf.readBigUInt64LE(8));
            const fallback = Number(dumpBuf.readBigUInt64LE(16));
            const rootH2d = Number(dumpBuf.readBigUInt64LE(24));
            const bytesCurrent = Number(dumpBuf.readBigUInt64LE(32));
            const bytesH2d = Number(dumpBuf.readBigUInt64LE(40));
            const changedPagesTotal = Number(dumpBuf.readBigUInt64LE(48));
            const usH2dCurrent = dumpBuf.readDoubleLE(56);
            const usH2dRoot = dumpBuf.readDoubleLE(64);
            const usKernel = dumpBuf.readDoubleLE(72);
            const usD2h = dumpBuf.readDoubleLE(80);
            const currentRegisterCalls = Number(dumpBuf.readBigUInt64LE(88));
            const currentRegisterSkips = Number(dumpBuf.readBigUInt64LE(96));
            const currentRegisterHits = Number(dumpBuf.readBigUInt64LE(104));
            const currentRegisterSuccess = Number(dumpBuf.readBigUInt64LE(112));
            const currentRegisterFail = Number(dumpBuf.readBigUInt64LE(120));
            console.error('===== Snapshot Accel Stats (GPU) =====');
            console.error(`calls=${calls} mapped=${mapped} fallback=${fallback} rootH2d=${rootH2d}`);
            console.error(`avgCurrentBytes=${(bytesCurrent / Math.max(1, calls)).toFixed(0)} avgH2dBytes=${(bytesH2d / Math.max(1, calls)).toFixed(0)} avgChangedPages=${(changedPagesTotal / Math.max(1, calls)).toFixed(1)}`);
            console.error(`avg us: h2d_current=${(usH2dCurrent / Math.max(1, calls)).toFixed(1)} h2d_root=${(usH2dRoot / Math.max(1, calls)).toFixed(1)} kernel=${(usKernel / Math.max(1, calls)).toFixed(1)} d2h=${(usD2h / Math.max(1, calls)).toFixed(1)}`);
            console.error(`total ms: h2d_current=${(usH2dCurrent / 1000).toFixed(0)} h2d_root=${(usH2dRoot / 1000).toFixed(0)} kernel=${(usKernel / 1000).toFixed(0)} d2h=${(usD2h / 1000).toFixed(0)}`);
            console.error(`current host register: calls=${currentRegisterCalls} hits=${currentRegisterHits} success=${currentRegisterSuccess} fail=${currentRegisterFail} skips=${currentRegisterSkips}`);
          } catch (err) {
            console.error('[snapshot-accel-stats-dump-failed]', err?.message || err);
          }
        };
        process.on('exit', dumpOnce);
      }
      return snapshotState.getSnapshotAccelState();
    } catch {
      snapshotState.setSnapshotAccelState(null);
      return snapshotState.getSnapshotAccelState();
    }
  }

  function collectChangedPageOffsetsWithGpu(currentHeap, rootMemory, targetByteLength, pageSize) {
    const snapshotAccel = loadSnapshotAccel();
    if (!snapshotAccel || targetByteLength < MODERN_SNAPSHOT_GPU_MIN_BYTES) return null;
    const offsetBackend = resolveOffsetGpuBackend(snapshotAccel);
    if (!offsetBackend) return null;
    try {
      const pageCount = Math.ceil(targetByteLength / pageSize);
      const scratch = snapshotAccel.scratch ?? {};
      const usesPrefixedOffsets = offsetBackend.mode === 'prefixed';
      if (usesPrefixedOffsets) {
        scratch.countAndOffsets = ensureScratchBuffer(scratch.countAndOffsets, (pageCount + 1) * 4);
        scratch.countAndOffsets.writeUInt32LE(0, 0);
      } else {
        scratch.offsets = ensureScratchBuffer(scratch.offsets, pageCount * 4);
      }
      snapshotAccel.scratch = scratch;
      const currentBytes = getScratchBufferView(scratch, 'currentBytes', currentHeap, targetByteLength);
      const rootBytes = getScratchBufferView(
        scratch,
        'rootBytes',
        rootMemory,
        Math.min(rootMemory.byteLength, targetByteLength),
      );
      const nativeCallStartedAt = startProfileTimer();
      const changedCount = offsetBackend.fn(
        currentBytes,
        targetByteLength >>> 0,
        rootBytes,
        rootBytes.byteLength >>> 0,
        pageSize >>> 0,
        usesPrefixedOffsets ? scratch.countAndOffsets : scratch.offsets,
        pageCount >>> 0,
      );
      endProfileTimer(
        offsetBackend.mode === 'prefixed'
          ? 'snapshotAccel.gpuPrefixedOffsets.nativeCall'
          : offsetBackend.mode === 'mapped'
          ? 'snapshotAccel.gpuMappedOffsets.nativeCall'
          : 'snapshotAccel.gpuOffsets.nativeCall',
        nativeCallStartedAt,
      );
      if (!Number.isInteger(changedCount) || changedCount < 0) return null;
      if (changedCount === 0) return new Uint32Array(0);
      const cloneStartedAt = startProfileTimer();
      const offsetsByteOffset = usesPrefixedOffsets
        ? scratch.countAndOffsets.byteOffset + 4
        : scratch.offsets.byteOffset;
      const offsetsBuffer = usesPrefixedOffsets ? scratch.countAndOffsets.buffer : scratch.offsets.buffer;
      const result = new Uint32Array(
        offsetsBuffer,
        offsetsByteOffset,
        changedCount,
      ).slice();
      endProfileTimer(
        offsetBackend.mode === 'prefixed'
          ? 'snapshotAccel.gpuPrefixedOffsets.clone'
          : offsetBackend.mode === 'mapped'
          ? 'snapshotAccel.gpuMappedOffsets.clone'
          : 'snapshotAccel.gpuOffsets.clone',
        cloneStartedAt,
      );
      return result;
    } catch {
      return null;
    }
  }

  function packChangedPages(currentBytes, pageOffsets, targetByteLength, pageSize) {
    const count = pageOffsets?.length ?? 0;
    if (count <= 0) {
      return {
        pageOffsets,
        pageData: new Uint8Array(0),
        pageSize,
        byteLength: 0,
      };
    }
    const lastOffset = pageOffsets[count - 1] >>> 0;
    const lastLength = Math.max(0, Math.min(pageSize, targetByteLength - lastOffset));
    const byteLength = ((count - 1) * pageSize) + lastLength;
    const pageData = Buffer.allocUnsafe(byteLength);
    let writeOffset = 0;
    for (let index = 0; index < count; index += 1) {
      const offset = pageOffsets[index] >>> 0;
      const end = Math.min(offset + pageSize, targetByteLength);
      const pageLength = Math.max(0, end - offset);
      currentBytes.copy(pageData, writeOffset, offset, end);
      writeOffset += pageLength;
    }
    return {
      pageOffsets,
      pageData,
      pageSize,
      byteLength,
    };
  }

  function collectChangedPagesPackedWithGpu(currentHeap, rootMemory, targetByteLength, pageSize) {
    const snapshotAccel = loadSnapshotAccel();
    if (!snapshotAccel || targetByteLength < MODERN_SNAPSHOT_GPU_MIN_BYTES) return null;
    const packedBackend = resolvePackedGpuBackend(snapshotAccel);
    if (!packedBackend) return null;
    try {
      const pageCount = Math.ceil(targetByteLength / pageSize);
      const scratch = snapshotAccel.scratch ?? {};
      scratch.offsets = ensureScratchBuffer(scratch.offsets, pageCount * 4);
      scratch.pageData = ensureScratchBuffer(scratch.pageData, targetByteLength);
      scratch.packedBytes = ensureScratchBuffer(scratch.packedBytes, 4);
      scratch.packedBytes.writeUInt32LE(0, 0);
      snapshotAccel.scratch = scratch;
      const currentBytes = getScratchBufferView(scratch, 'currentBytes', currentHeap, targetByteLength);
      const rootBytes = getScratchBufferView(
        scratch,
        'rootBytes',
        rootMemory,
        Math.min(rootMemory.byteLength, targetByteLength),
      );
      const nativeCallStartedAt = startProfileTimer();
      const changedCount = packedBackend.fn(
        currentBytes,
        targetByteLength >>> 0,
        rootBytes,
        rootBytes.byteLength >>> 0,
        pageSize >>> 0,
        scratch.offsets,
        pageCount >>> 0,
        scratch.pageData,
        targetByteLength >>> 0,
        scratch.packedBytes,
      );
      endProfileTimer(
        packedBackend.mode === 'device'
          ? 'snapshotAccel.gpuDevicePacked.nativeCall'
          : 'snapshotAccel.gpuPacked.nativeCall',
        nativeCallStartedAt,
      );
      if (!Number.isInteger(changedCount) || changedCount < 0) return null;
      if (changedCount === 0) {
        return {
          pageOffsets: new Uint32Array(0),
          pageData: new Uint8Array(0),
          pageSize,
          byteLength: 0,
        };
      }
      const packedBytes = scratch.packedBytes.readUInt32LE(0);
      if (packedBytes > targetByteLength) return null;
      const cloneStartedAt = startProfileTimer();
      // 用 Uint32Array.prototype.slice() 一次 memcpy 替代 Uint32Array.from(new Uint32Array(...))
      // 后者走 iterator path，实测在 36k+ 次调用下显著更慢。
      const offsetsView = new Uint32Array(
        scratch.offsets.buffer,
        scratch.offsets.byteOffset,
        changedCount,
      );
      const result = {
        pageOffsets: offsetsView.slice(),
        pageData: Buffer.from(scratch.pageData.subarray(0, packedBytes)),
        pageSize,
        byteLength: packedBytes,
      };
      endProfileTimer(
        packedBackend.mode === 'device'
          ? 'snapshotAccel.gpuDevicePacked.clone'
          : 'snapshotAccel.gpuPacked.clone',
        cloneStartedAt,
      );
      return result;
    } catch {
      return null;
    }
  }

  function collectChangedPagesAgainstRootCpu(
    currentHeap,
    rootMemory,
    targetByteLength,
    pageSize = MODERN_SNAPSHOT_PAGE_SIZE,
  ) {
    if (!(currentHeap instanceof Uint8Array) || !(rootMemory instanceof Uint8Array)) {
      return {
        pageOffsets: new Uint32Array(0),
        pageData: new Uint8Array(0),
        pageSize,
        byteLength: 0,
      };
    }
    const currentBytes = Buffer.from(
      currentHeap.buffer,
      currentHeap.byteOffset,
      targetByteLength,
    );
    const offsets = [];
    for (let start = 0; start < targetByteLength; start += pageSize) {
      const end = Math.min(start + pageSize, targetByteLength);
      if (!pageDiffers(currentHeap, rootMemory, start, end)) continue;
      offsets.push(start);
    }
    return packChangedPages(
      currentBytes,
      Uint32Array.from(offsets),
      targetByteLength,
      pageSize,
    );
  }

  function collectChangedPagesAgainstRoot(
    currentHeap,
    rootMemory,
    targetByteLength,
    pageSize = MODERN_SNAPSHOT_PAGE_SIZE,
  ) {
    const startedAt = startProfileTimer();
    if (!(currentHeap instanceof Uint8Array) || !(rootMemory instanceof Uint8Array)) {
      endProfileTimer('collectChangedPagesAgainstRoot', startedAt);
      return {
        pageOffsets: new Uint32Array(0),
        pageData: new Uint8Array(0),
        pageSize,
        byteLength: 0,
      };
    }
    try {
      const packedGpuResult = collectChangedPagesPackedWithGpu(
        currentHeap,
        rootMemory,
        targetByteLength,
        pageSize,
      );
      if (packedGpuResult) {
        return packedGpuResult;
      }
      const guardedWindow = findGuardedPrefixDiffWindow(
        currentHeap,
        rootMemory,
        targetByteLength,
        pageSize,
      );
      if (guardedWindow?.byteLength === 0) {
        return {
          pageOffsets: new Uint32Array(0),
          pageData: new Uint8Array(0),
          pageSize,
          byteLength: 0,
        };
      }
      const gpuDiffByteLength =
        guardedWindow && guardedWindow.byteLength >= MODERN_SNAPSHOT_GPU_MIN_BYTES
          ? guardedWindow.byteLength
          : targetByteLength;
      const gpuOffsets = collectChangedPageOffsetsWithGpu(
        currentHeap,
        rootMemory,
        gpuDiffByteLength,
        pageSize,
      );
      if (gpuOffsets instanceof Uint32Array) {
        const currentBytes = Buffer.from(
          currentHeap.buffer,
          currentHeap.byteOffset,
          targetByteLength,
        );
        return packChangedPages(currentBytes, gpuOffsets, targetByteLength, pageSize);
      }
      return collectChangedPagesAgainstRootCpu(
        currentHeap,
        rootMemory,
        targetByteLength,
        pageSize,
      );
    } finally {
      endProfileTimer('collectChangedPagesAgainstRoot', startedAt);
    }
  }

  return {
    pageDiffers,
    loadSnapshotAccel,
    collectChangedPageOffsetsWithGpu,
    collectChangedPagesAgainstRootCpu,
    collectChangedPagesAgainstRoot,
    resolvePackedGpuBackend,
    resolveOffsetGpuBackend,
  };
}

module.exports = {
  createSnapshotAccelRuntimeApi,
};
