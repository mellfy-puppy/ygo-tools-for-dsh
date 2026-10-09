import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { serializeYdkText } from './deck-core.mjs';

const require = createRequire(import.meta.url);
const BUNDLED_SERVER_EXECUTABLE = fileURLToPath(new URL('../resources/ygopro2-bridge/server/AI.Server.exe', import.meta.url));
const BUNDLED_CLIENT_EXECUTABLE = fileURLToPath(new URL('../resources/ygopro2-client/YGOPro2.exe', import.meta.url));
const { requireSkillDependency } = require('../runtime/src/vendor-require.cjs');
const ygopro = requireSkillDependency('ygopro-msg-encode');
const JSZip = requireSkillDependency('jszip');
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_DECISION_TIMEOUT_MS = 120000;
const MAX_LOG_LENGTH = 20000;
const CTOS_TP_RESULT = 0x04;
const STOC_REPLAY = 0x17;
const STOC_DUEL_START = 0x15;
const DEFAULT_HOST_PORT = 7911;
const DEFAULT_HOST_WAIT_MS = 120000;
const MAX_HOST_WAIT_MS = 280000;
const MAX_CHAT_LOG = 200;
const MAX_AUTO_RESOLVED_LOG = 30;
const MAX_CONSECUTIVE_AUTO_RESOLVED = 200;
const CHAT_CHUNK_LENGTH = 120;

export async function createYgoPro2DuelRunner(options) {
  const runner = new YgoPro2DuelRunner(options);
  try {
    await runner.start();
    return runner;
  } catch (error) {
    await runner.dispose();
    throw error;
  }
}

export function isYgoPro2DuelRunner(value) {
  return Boolean(value?.duelBackend === 'ygopro2-ai-server' && value?.externalDuel === true);
}

function autoResolvedField(entries) {
  return entries.length ? { autoResolved: entries } : {};
}

export async function executeYgoPro2Action(runner, input = {}, formatCurrentState) {
  if (!isYgoPro2DuelRunner(runner)) {
    return { ok: false, code: 'YGOPRO2_DUEL_NOT_RUNNING', error: 'No YGOPro2 AI.Server duel is running in this session.' };
  }
  if (runner.hostMode && !runner.decisionReady && !runner.currentDecision?.terminal) {
    return { ok: false, code: 'YGOPRO2_NO_PENDING_DECISION', error: 'The model has no pending decision; call manageYgoPro2 action:"wait" until event is "decision".' };
  }
  const prepared = prepareSelectedAction(runner.currentDecision, input);
  if (!prepared.ok) return prepared;
  const historyBefore = runner.actionHistory.length;
  if (runner.hostMode) {
    try {
      await runner.submitResponse(prepared.response, prepared.action);
    } catch (error) {
      return { ok: false, code: 'YGOPRO2_ACTION_FAILED', error: error instanceof Error ? error.message : String(error) };
    }
    const waited = await waitForYgoPro2HostEvent(runner, { waitMs: input.waitMs }, formatCurrentState, input.graveyardLimit);
    return { ...waited, data: { executedAction: summarizeAction(prepared.action, prepared.index), ...waited.data } };
  }
  try {
    await runner.submitResponse(prepared.response, prepared.action);
  } catch (error) {
    return {
      ok: false,
      code: 'YGOPRO2_ACTION_FAILED',
      error: error instanceof Error ? error.message : String(error),
      fatal: true,
      requiresReset: true,
    };
  }
  const state = typeof formatCurrentState === 'function'
    ? formatCurrentState(runner.captureSnapshot(), { runner, graveyardLimit: input.graveyardLimit })
    : runner.captureSnapshot();
  return {
    ok: true,
    data: {
      executedAction: summarizeAction(prepared.action, prepared.index),
      ...autoResolvedField(runner.takeAutoResolved()),
      nextDecision: summarizeDecision(runner.currentDecision),
      state,
      historyLength: { before: historyBefore, after: runner.actionHistory.length },
      automaticCheckpoint: null,
      duelBackend: runner.duelBackend,
      opponentControlledBy: 'windbot',
      bridge: runner.getBridgeStatus(),
    },
  };
}

// Blocks until the model must decide, the opponent chats, the duel ends, or
// waitMs elapses. A timeout is a normal result: call wait again.
export async function waitForYgoPro2HostEvent(runner, input = {}, formatCurrentState, graveyardLimit) {
  if (!isYgoPro2DuelRunner(runner) || !runner.hostMode) {
    return { ok: false, code: 'YGOPRO2_HOST_NOT_RUNNING', error: 'No YGOPro2 host match is running in this session; call manageYgoPro2 action:"host".' };
  }
  const waitMs = Math.min(MAX_HOST_WAIT_MS, normalizeTimeout(input.waitMs, DEFAULT_HOST_WAIT_MS));
  const result = await runner.waitForHostEvent(waitMs);
  const includeState = result.event === 'decision' || result.event === 'terminal';
  return {
    ok: true,
    data: {
      ...result,
      nextDecision: result.decisionPending ? summarizeDecision(runner.currentDecision) : null,
      state: includeState
        ? (typeof formatCurrentState === 'function'
          ? formatCurrentState(runner.captureSnapshot(), { runner, graveyardLimit })
          : runner.captureSnapshot())
        : null,
      room: runner.getRoomInfo(),
      hint: result.event === 'timeout'
        ? 'Nothing needed from the model yet (the opponent is joining or thinking). Call manageYgoPro2 action:"wait" again.'
        : result.event === 'chat'
          ? 'Reply with manageYgoPro2 action:"chat" if appropriate, then wait again or act on a pending decision.'
          : undefined,
    },
  };
}

export function sendYgoPro2Chat(runner, input = {}) {
  if (!isYgoPro2DuelRunner(runner) || !runner.hostMode) {
    return { ok: false, code: 'YGOPRO2_HOST_NOT_RUNNING', error: 'No YGOPro2 host match is running in this session.' };
  }
  const text = readString(input.text);
  if (!text) return { ok: false, code: 'CHAT_TEXT_REQUIRED', error: 'chat requires non-empty text.' };
  try {
    return { ok: true, data: { sent: runner.sendChat(text) } };
  } catch (error) {
    return { ok: false, code: 'YGOPRO2_CHAT_FAILED', error: error instanceof Error ? error.message : String(error) };
  }
}

export function getYgoPro2BridgeStatus(context) {
  const session = context?.session ?? context;
  const runner = session?.runner ?? context?.runner ?? null;
  if (!isYgoPro2DuelRunner(runner)) {
    return {
      ok: true,
      data: {
        running: false,
        liveDuelBridge: false,
        discovery: session?.metadata?.ygoPro2Discovery ?? null,
      },
    };
  }
  return { ok: true, data: runner.getBridgeStatus() };
}

class YgoPro2DuelRunner {
  constructor(options) {
    this.duelBackend = 'ygopro2-ai-server';
    this.externalDuel = true;
    this.enumerator = options.enumerator;
    this.cardText = options.enumerator?.cardText;
    this.playerDeckInstances = options.enumerator?.playerDeckInstances;
    this.playerDeck = cloneDeck(options.playerDeck);
    this.opponentDeck = options.opponentDeck ? cloneDeck(options.opponentDeck) : { main: [], extra: [], side: [] };
    this.opponentAiProfile = options.opponentAiProfile;
    this.playerTurnOrder = options.playerTurnOrder;
    this.installation = options.installation;
    this.externalPolicyClient = options.externalPolicyClient;
    this.startupTimeoutMs = normalizeTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    this.decisionTimeoutMs = normalizeTimeout(options.decisionTimeoutMs, DEFAULT_DECISION_TIMEOUT_MS);
    this.currentDecision = null;
    this.currentState = emptyState();
    this.actionHistory = [];
    this.engineMessages = [];
    this.processes = [];
    this.logs = new Map();
    this.policyServer = null;
    this.policySocket = null;
    this.policyPort = null;
    this.duelPort = null;
    this.turnOrderProxyServer = null;
    this.turnOrderProxySocket = null;
    this.turnOrderUpstreamSocket = null;
    this.turnOrderProxyPort = null;
    this.turnOrderSelectionApplied = false;
    this.turnOrderProtocolValue = null;
    this.tempDirectory = null;
    this.compatibilityRuntime = null;
    this.pendingUpdate = null;
    this.startedAt = null;
    this.episodeId = `ygoagentskill-${randomUUID()}`;
    this.disposed = false;
    this.terminalResult = null;
    this.replayBytes = null;
    this.surrenderRequested = false;
    this.surrenderedAt = null;
    // Host mode: a human YGOPro2 client joins by IP:port and plays against the model.
    this.hostMode = options.mode === 'host';
    this.hostPort = Number.isSafeInteger(Number(options.hostPort)) ? Number(options.hostPort) : DEFAULT_HOST_PORT;
    this.bindAddress = readString(options.bindAddress) ?? '127.0.0.1';
    this.botName = (readString(options.botName) ?? 'DSH-AI').slice(0, 20);
    this.publicServer = null;
    this.humanSockets = new Set();
    this.humanConnectedAt = null;
    this.decisionReady = false;
    this.chatInbox = [];
    this.chatLog = [];
    this.hostError = null;
    this.hostWaiters = new Set();
    this.autoResolveForced = options.autoResolveForced !== false;
    this.autoResolved = [];
    this.autoResolvedTotal = 0;
    this.consecutiveAutoResolved = 0;
    this.cardData = options.cardData ?? null;
    this.duelStartedAt = null;
    this.clientLaunch = null;
  }

  async start() {
    validateLaunchOptions(this);
    if (this.hostMode) return this.startHost();
    this.tempDirectory = await mkdtemp(join(tmpdir(), 'ygoagentskill-ygopro2-'));
    const playerDeckFile = join(this.tempDirectory, 'player.ydk');
    await writeFile(playerDeckFile, serializeYdkText(this.playerDeck), 'utf8');
    let opponentDeckFile = null;
    if (this.opponentDeck.main.length > 0) {
      opponentDeckFile = join(this.tempDirectory, 'opponent.ydk');
      await writeFile(opponentDeckFile, serializeYdkText(this.opponentDeck), 'utf8');
    }

    await this.startPolicyServer();
    this.compatibilityRuntime = await prepareYgoPro2CompatibilityRuntime(
      this.installation,
      join(this.tempDirectory, 'ai-server-runtime'),
    );
    this.duelPort = await reserveLoopbackPort();
    const server = this.spawnProcess('ai-server', this.compatibilityRuntime.serverExecutable, [
      String(this.duelPort), '-1', '5', '0', 'F', 'F', 'F', '8000', '5', '1', '0', '0',
    ], this.compatibilityRuntime.root);
    await waitForListeningPort(server, this.duelPort, this.startupTimeoutMs);
    await this.startTurnOrderProxy(this.duelPort);
    const firstUpdate = this.waitForUpdate(this.startupTimeoutMs);
    this.spawnProcess('model-client', this.externalPolicyClient.executable, [
      'Name=YGOagentskill',
      'Deck=YGOFTKExternal',
      `DeckFile=${playerDeckFile}`,
      'Host=127.0.0.1',
      `Port=${this.turnOrderProxyPort}`,
      'Hand=2',
      'Chat=false',
      `AgentPort=${this.policyPort}`,
      `EpisodeId=${this.episodeId}`,
      `AgentTimeoutMs=${this.decisionTimeoutMs}`,
      `DbPath=${this.installation.paths.cardsDatabase}`,
    ], this.externalPolicyClient.workingDirectory);
    await delay(250);
    const opponentArgs = [
      `Name=${this.opponentAiProfile}`,
      `Deck=${this.opponentAiProfile}`,
      'Host=127.0.0.1',
      `Port=${this.duelPort}`,
      'Hand=1',
      'Chat=false',
      `DbPath=${this.installation.paths.cardsDatabase}`,
    ];
    if (opponentDeckFile) opponentArgs.push(`DeckFile=${opponentDeckFile}`);
    this.spawnProcess(
      'opponent-windbot',
      this.installation.paths.windbotExecutable,
      opponentArgs,
      dirname(this.installation.paths.windbotExecutable),
    );
    await firstUpdate;
    if (!this.turnOrderSelectionApplied) {
      throw new Error('YGOPro2 reached a model decision without submitting the requested first/second selection.');
    }
    this.startedAt = new Date().toISOString();
    return this;
  }

  // Starts AI.Server, seats the model-controlled WindBot, and opens the public
  // port that a human YGOPro2 client joins. Returns before the human arrives.
  async startHost() {
    this.tempDirectory = await mkdtemp(join(tmpdir(), 'ygoagentskill-ygopro2-host-'));
    const playerDeckFile = join(this.tempDirectory, 'player.ydk');
    await writeFile(playerDeckFile, serializeYdkText(this.playerDeck), 'utf8');
    await this.startPolicyServer();
    // Hosted rooms run the bundled AI.Server on the plugin's card data.
    this.compatibilityRuntime = await prepareBundledServerRuntime(
      this.cardData,
      join(this.tempDirectory, 'ai-server-runtime'),
    );
    this.duelPort = await reserveLoopbackPort();
    const server = this.spawnProcess('ai-server', this.compatibilityRuntime.serverExecutable, [
      String(this.duelPort), '-1', '5', '0', 'F', 'F', 'F', '8000', '5', '1', '0', '0',
    ], this.compatibilityRuntime.root);
    await waitForListeningPort(server, this.duelPort, this.startupTimeoutMs);
    await this.startPublicServer();
    const args = [
      `Name=${this.botName}`,
      'Deck=YGOFTKExternal',
      `DeckFile=${playerDeckFile}`,
      'Host=127.0.0.1',
      `Port=${this.duelPort}`,
      'Hand=0',
      'Chat=false',
      `AgentPort=${this.policyPort}`,
      `EpisodeId=${this.episodeId}`,
      'AgentTimeoutMs=0',
      'FullDuel=true',
      `DbPath=${this.cardData.cardsDbPath}`,
    ];
    const extraDbs = this.compatibilityRuntime.cardDatabases.slice(1);
    if (extraDbs.length > 0) args.push(`ExtraDbPaths=${extraDbs.join(';')}`);
    if (this.playerTurnOrder) args.push(`TurnOrder=${this.playerTurnOrder}`);
    this.spawnProcess('model-client', this.externalPolicyClient.executable, args, this.externalPolicyClient.workingDirectory);
    const deadline = Date.now() + this.startupTimeoutMs;
    while (!this.policySocket && !this.hostError && Date.now() < deadline) await delay(50);
    if (this.hostError) throw new Error(this.hostError);
    if (!this.policySocket) throw new Error(`Model WindBot did not connect within ${this.startupTimeoutMs} ms.`);
    this.startedAt = new Date().toISOString();
    return this;
  }

  async startPublicServer() {
    this.publicServer = net.createServer((socket) => {
      this.humanSockets.add(socket);
      this.humanConnectedAt ??= new Date().toISOString();
      socket.setNoDelay(true);
      const upstream = net.createConnection({ host: '127.0.0.1', port: this.duelPort });
      upstream.setNoDelay(true);
      socket.pipe(upstream);
      upstream.pipe(socket);
      // Capture the server replay packet on its way to the human client.
      let pending = Buffer.alloc(0);
      upstream.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 2) {
          const frameLength = pending.readUInt16LE(0) + 2;
          if (pending.length < frameLength) break;
          if (frameLength >= 3 && pending[2] === STOC_REPLAY) this.replayBytes = Uint8Array.from(pending.subarray(3, frameLength));
          if (frameLength >= 3 && pending[2] === STOC_DUEL_START && !this.duelStartedAt) {
            this.duelStartedAt = new Date().toISOString();
            this.notifyHost();
          }
          pending = pending.subarray(frameLength);
        }
      });
      const close = () => {
        socket.destroy();
        upstream.destroy();
        this.humanSockets.delete(socket);
      };
      socket.once('close', close);
      upstream.once('close', close);
      socket.on('error', () => {});
      upstream.on('error', () => {});
    });
    await new Promise((resolvePromise, reject) => {
      this.publicServer.once('error', (error) => reject(error?.code === 'EADDRINUSE'
        ? new Error(`Port ${this.hostPort} on ${this.bindAddress} is already in use; choose another hostPort.`)
        : error));
      this.publicServer.listen(this.hostPort, this.bindAddress, resolvePromise);
    });
  }

  notifyHost() {
    for (const waiter of [...this.hostWaiters]) waiter();
  }

  hasHostEvent() {
    return Boolean(this.hostError || this.currentDecision?.terminal || this.decisionReady || this.chatInbox.length > 0);
  }

  async waitForHostEvent(timeoutMs) {
    if (!this.hasHostEvent()) {
      await new Promise((resolvePromise) => {
        const done = () => {
          clearTimeout(timer);
          this.hostWaiters.delete(done);
          resolvePromise();
        };
        const timer = setTimeout(done, timeoutMs);
        this.hostWaiters.add(done);
      });
    }
    const chat = this.chatInbox.splice(0);
    const terminal = Boolean(this.currentDecision?.terminal);
    const autoResolved = this.takeAutoResolved();
    return {
      event: this.hostError ? 'error' : terminal ? 'terminal' : this.decisionReady ? 'decision' : chat.length > 0 ? 'chat' : 'timeout',
      chat,
      ...(autoResolved.length ? { autoResolved } : {}),
      decisionPending: this.decisionReady && !terminal,
      terminalResult: this.terminalResult,
      error: this.hostError,
    };
  }

  sendChat(text) {
    if (!this.policySocket || this.policySocket.destroyed) throw new Error('Model WindBot is not connected.');
    const chunks = splitChat(text);
    for (const chunk of chunks) {
      this.policySocket.write(`${JSON.stringify({ chat: chunk })}\n`);
      this.recordChat({ at: new Date().toISOString(), from: this.botName, self: true, text: chunk });
    }
    return chunks;
  }

  recordChat(entry) {
    this.chatLog.push(entry);
    if (this.chatLog.length > MAX_CHAT_LOG) this.chatLog.splice(0, this.chatLog.length - MAX_CHAT_LOG);
  }

  getRoomInfo() {
    if (!this.hostMode) return null;
    const hosts = this.bindAddress === '0.0.0.0' ? ['127.0.0.1', ...lanAddresses()] : [this.bindAddress];
    return {
      bindAddress: this.bindAddress,
      port: this.hostPort,
      connectAddresses: hosts.map((host) => `${host}:${this.hostPort}`),
      password: '',
      botName: this.botName,
      modelTurnOrder: this.playerTurnOrder ?? 'rock-paper-scissors',
      opponentConnected: this.humanSockets.size > 0,
      opponentConnectedAt: this.humanConnectedAt,
      duelStartedAt: this.duelStartedAt,
      clientLaunch: this.clientLaunch,
    };
  }

  async startTurnOrderProxy(duelPort) {
    this.turnOrderProxyServer = net.createServer((socket) => {
      if (this.turnOrderProxySocket && !this.turnOrderProxySocket.destroyed) {
        socket.destroy(new Error('Only one model client is allowed through the turn-order proxy.'));
        return;
      }
      this.turnOrderProxySocket = socket;
      socket.setNoDelay(true);
      const upstream = net.createConnection({ host: '127.0.0.1', port: duelPort });
      this.turnOrderUpstreamSocket = upstream;
      upstream.setNoDelay(true);
      let clientPending = Buffer.alloc(0);
      let serverPending = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        clientPending = Buffer.concat([clientPending, chunk]);
        while (clientPending.length >= 2) {
          const payloadLength = clientPending.readUInt16LE(0);
          const frameLength = payloadLength + 2;
          if (clientPending.length < frameLength) break;
          const frame = Buffer.from(clientPending.subarray(0, frameLength));
          clientPending = clientPending.subarray(frameLength);
          if (payloadLength >= 2 && frame[2] === CTOS_TP_RESULT) {
            this.turnOrderProtocolValue = this.playerTurnOrder === 'first' ? 1 : 0;
            frame[3] = this.turnOrderProtocolValue;
            this.turnOrderSelectionApplied = true;
          }
          upstream.write(frame);
        }
      });
      upstream.on('data', (chunk) => {
        serverPending = Buffer.concat([serverPending, chunk]);
        while (serverPending.length >= 2) {
          const payloadLength = serverPending.readUInt16LE(0);
          const frameLength = payloadLength + 2;
          if (serverPending.length < frameLength) break;
          const frame = Buffer.from(serverPending.subarray(0, frameLength));
          serverPending = serverPending.subarray(frameLength);
          if (payloadLength >= 1 && frame[2] === STOC_REPLAY) {
            this.replayBytes = Uint8Array.from(frame.subarray(3));
          }
          socket.write(frame);
        }
      });
      const closePeer = (peer) => { if (peer && !peer.destroyed) peer.destroy(); };
      socket.once('close', () => closePeer(upstream));
      upstream.once('close', () => closePeer(socket));
      socket.on('error', (error) => this.failPending(new Error(`Turn-order proxy client failed: ${error.message}`)));
      upstream.on('error', (error) => this.failPending(new Error(`Turn-order proxy upstream failed: ${error.message}`)));
    });
    await new Promise((resolvePromise, reject) => {
      this.turnOrderProxyServer.once('error', reject);
      this.turnOrderProxyServer.listen(0, '127.0.0.1', () => {
        this.turnOrderProxyServer.off('error', reject);
        resolvePromise();
      });
    });
    this.turnOrderProxyPort = this.turnOrderProxyServer.address().port;
  }

  async startPolicyServer() {
    this.policyServer = net.createServer((socket) => {
      if (this.policySocket && !this.policySocket.destroyed) {
        socket.destroy(new Error('Only one external policy client is allowed per duel.'));
        return;
      }
      this.policySocket = socket;
      socket.setNoDelay(true);
      socket.on('error', (error) => this.failPending(error));
      socket.once('close', () => {
        if (!this.disposed && !this.currentDecision?.terminal) {
          this.failPending(new Error('External policy client disconnected before the duel ended.'));
        }
      });
      const lines = createInterface({ input: socket, crlfDelay: Infinity });
      lines.on('line', (line) => {
        try {
          this.handlePolicyRequest(JSON.parse(line));
        } catch (error) {
          this.failPending(error);
          socket.destroy();
        }
      });
    });
    await new Promise((resolvePromise, reject) => {
      this.policyServer.once('error', reject);
      this.policyServer.listen(0, '127.0.0.1', () => {
        this.policyServer.off('error', reject);
        resolvePromise();
      });
    });
    this.policyPort = this.policyServer.address().port;
  }

  handlePolicyRequest(request) {
    if (!request || request.episodeId !== this.episodeId) return;
    const scriptErrors = this.getScriptErrors();
    if (scriptErrors.length > 0) {
      const serverLog = this.logs.get('ai-server')?.logs ?? '';
      throw new Error(`AI.Server failed to initialize one or more Lua scripts: ${scriptErrors.join(' | ')}\nAI.Server log:\n${serverLog.slice(-12000)}`);
    }
    if (request.type === 'decision') {
      const payload = Buffer.from(String(request.messageBase64 ?? ''), 'base64');
      const message = ygopro.YGOProMessages.getInstanceFromPayload(payload);
      if (!message) throw new Error(`Unsupported YGOPro2 decision message: ${request.message ?? payload[0] ?? 'unknown'}.`);
      const decision = this.enumerator.tryBuildDecisionFromMessage(message);
      if (!decision) throw new Error(`Unable to enumerate YGOPro2 decision ${message.constructor?.name ?? request.message ?? 'unknown'}.`);
      decision.responsePlayer = 0;
      this.currentState = normalizePolicyState(request.state);
      // A decision with exactly one legal answer (most often a chain window
      // whose only option is "不连锁") is answered here instead of asking the model.
      const forced = forcedDecisionAction(decision);
      // The cap hands control back to the model if the server keeps re-asking
      // (for example after rejecting the response) instead of looping forever.
      if (forced && this.autoResolveForced && this.consecutiveAutoResolved < MAX_CONSECUTIVE_AUTO_RESOLVED) {
        this.consecutiveAutoResolved += 1;
        this.autoRespond(decision, forced);
        return;
      }
      this.currentDecision = decision;
      this.decisionReady = true;
      this.resolvePending({ type: 'decision' });
      this.notifyHost();
      return;
    }
    if (request.type === 'chat') {
      const entry = {
        at: new Date().toISOString(),
        from: String(request.sender ?? `player${request.player ?? ''}`),
        player: Number(request.player ?? -1),
        text: String(request.text ?? ''),
      };
      this.chatInbox.push(entry);
      this.recordChat(entry);
      this.notifyHost();
      return;
    }
    if (request.type === 'terminal') {
      this.currentState = normalizePolicyState(request.state);
      this.terminalResult = this.surrenderRequested ? 'surrender' : String(request.result ?? 'unknown');
      this.currentDecision = {
        terminal: true,
        reason: this.surrenderRequested ? 'YGOPRO2_SURRENDER' : `YGOPRO2_${this.terminalResult.toUpperCase()}`,
        actions: [],
        message: null,
      };
      this.decisionReady = false;
      this.resolvePending({ type: 'terminal' });
      this.notifyHost();
      return;
    }
    if (request.type === 'replay' && request.replayBase64) {
      this.replayBytes = Uint8Array.from(Buffer.from(request.replayBase64, 'base64'));
    }
  }

  // Sends the only legal answer without involving the model. The pending
  // waiter (if any) stays open until the next real decision or the duel end.
  autoRespond(decision, action) {
    const response = actionResponseBytes(action);
    this.actionHistory.push({ label: String(action.label ?? ''), kind: 'auto', response: Uint8Array.from(response) });
    this.autoResolvedTotal += 1;
    this.autoResolved.push({ decision: decisionName(decision), label: String(action.label ?? '') });
    if (this.autoResolved.length > MAX_AUTO_RESOLVED_LOG) this.autoResolved.splice(0, this.autoResolved.length - MAX_AUTO_RESOLVED_LOG);
    this.policySocket.write(`${JSON.stringify({ responseBase64: Buffer.from(response).toString('base64') })}\n`);
  }

  takeAutoResolved() {
    return this.autoResolved.splice(0);
  }

  async submitResponse(response, action) {
    if (!this.policySocket || this.policySocket.destroyed) throw new Error('YGOPro2 external policy socket is not connected.');
    if (this.currentDecision?.terminal) throw new Error(`YGOPro2 duel is terminal: ${this.currentDecision.reason}.`);
    const responseBytes = Uint8Array.from(response ?? []);
    this.consecutiveAutoResolved = 0;
    this.actionHistory.push({
      label: String(action?.label ?? ''),
      kind: String(action?.kind ?? ''),
      response: responseBytes,
    });
    if (this.hostMode) {
      // The human may take any time; callers wait with waitForHostEvent.
      this.decisionReady = false;
      this.policySocket.write(`${JSON.stringify({ responseBase64: Buffer.from(responseBytes).toString('base64') })}\n`);
      return;
    }
    const nextUpdate = this.waitForUpdate(this.decisionTimeoutMs);
    this.policySocket.write(`${JSON.stringify({ responseBase64: Buffer.from(responseBytes).toString('base64') })}\n`);
    await nextUpdate;
  }

  async surrenderAndWaitForReplay(timeoutMs = 10000) {
    if (this.currentDecision?.terminal) {
      return {
        surrendered: this.terminalResult === 'surrender',
        alreadyTerminal: true,
        terminalResult: this.terminalResult,
        replayBytes: await this.waitForReplayBytes(timeoutMs),
      };
    }
    if (!this.policySocket || this.policySocket.destroyed) {
      throw new Error('YGOPro2 external policy socket is not connected.');
    }
    if (this.surrenderRequested) throw new Error('YGOPro2 surrender is already pending.');

    const terminalUpdate = this.waitForUpdate(this.decisionTimeoutMs);
    this.surrenderRequested = true;
    this.surrenderedAt = new Date().toISOString();
    this.actionHistory.push({ label: 'Surrender', kind: 'surrender', response: new Uint8Array() });
    await new Promise((resolvePromise, reject) => {
      this.policySocket.write(`${JSON.stringify({ surrender: true })}\n`, (error) => {
        if (error) reject(error);
        else resolvePromise();
      });
    });
    await terminalUpdate;
    return {
      surrendered: true,
      alreadyTerminal: false,
      terminalResult: this.terminalResult,
      replayBytes: await this.waitForReplayBytes(timeoutMs),
    };
  }

  waitForUpdate(timeoutMs) {
    if (this.pendingUpdate) throw new Error('A YGOPro2 decision wait is already pending.');
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pendingUpdate = null;
        reject(new Error(`YGOPro2 duel did not reach the next model decision within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pendingUpdate = {
        resolve: (value) => { clearTimeout(timer); this.pendingUpdate = null; resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); this.pendingUpdate = null; reject(error); },
      };
    });
  }

  resolvePending(value) {
    this.pendingUpdate?.resolve(value);
  }

  failPending(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (this.hostMode && !this.disposed && !this.currentDecision?.terminal && !this.hostError) {
      this.hostError = failure.message;
      this.notifyHost();
    }
    this.pendingUpdate?.reject(failure);
  }

  spawnProcess(label, executable, args, cwd) {
    const child = spawn(executable, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const record = { label, child, logs: '' };
    const collect = (chunk) => { record.logs = `${record.logs}${chunk.toString()}`.slice(-MAX_LOG_LENGTH); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => this.failPending(new Error(`${label} failed to start: ${error.message}`)));
    child.once('exit', (code) => {
      if (!this.disposed && !this.currentDecision?.terminal && code !== null) {
        this.failPending(new Error(`${label} exited with code ${code}: ${record.logs.slice(-4000)}`));
      }
    });
    this.processes.push(record);
    this.logs.set(label, record);
    return record;
  }

  captureSnapshot() {
    return policyStateToSnapshot(this.currentState);
  }

  async waitForReplayBytes(timeoutMs = 5000) {
    const deadline = Date.now() + normalizeTimeout(timeoutMs, 5000);
    while ((!this.replayBytes || this.replayBytes.length === 0) && Date.now() < deadline) {
      await delay(25);
    }
    return this.replayBytes && this.replayBytes.length > 0 ? Uint8Array.from(this.replayBytes) : null;
  }

  getBridgeStatus() {
    const scriptErrors = this.getScriptErrors();
    return {
      mode: this.hostMode ? 'host' : 'windbot-opponent',
      room: this.getRoomInfo(),
      decisionPending: this.hostMode ? this.decisionReady : undefined,
      hostEventPending: this.hostMode ? this.hasHostEvent() : undefined,
      autoResolvedForcedDecisions: this.autoResolvedTotal,
      hostError: this.hostError,
      recentChat: this.hostMode ? this.chatLog.slice(-20) : undefined,
      logTail: this.hostMode
        ? Object.fromEntries(this.processes.map(({ label, logs }) => [label, logs.slice(-1500)]))
        : undefined,
      running: !this.disposed,
      connected: Boolean(this.policySocket && !this.policySocket.destroyed),
      liveDuelBridge: Boolean(!this.disposed && this.policySocket && !this.policySocket.destroyed),
      duelBackend: this.duelBackend,
      startedAt: this.startedAt,
      opponentAiProfile: this.opponentAiProfile,
      playerTurnOrder: this.playerTurnOrder,
      turnOrderSelectionApplied: this.turnOrderSelectionApplied,
      turnOrderProtocolValue: this.turnOrderProtocolValue,
      terminalResult: this.terminalResult,
      surrenderRequested: this.surrenderRequested,
      surrenderedAt: this.surrenderedAt,
      replayAvailable: Boolean(this.replayBytes && this.replayBytes.length > 0),
      replayByteLength: this.replayBytes?.length ?? 0,
      currentDecision: this.currentDecision?.message?.constructor?.name ?? null,
      duelPort: this.duelPort,
      scriptCompatibility: this.compatibilityRuntime ? {
        mode: 'isolated-ai-server-runtime',
        sourceArchive: this.compatibilityRuntime.sourceArchive,
        bootstrapFiles: [...this.compatibilityRuntime.bootstrapFiles],
        replacedStaleFiles: [...this.compatibilityRuntime.replacedStaleFiles],
        compatibilityGlobals: [...this.compatibilityRuntime.compatibilityGlobals],
        patchedScripts: this.compatibilityRuntime.patchedScripts,
        resourceMappings: this.compatibilityRuntime.resourceMappings.map((entry) => ({ ...entry })),
        scriptErrors,
      } : null,
      processes: this.processes.map(({ label, child }) => ({ label, pid: child.pid ?? null, running: child.exitCode === null })),
      paths: {
        ygoPro2Root: this.installation?.root ?? null,
        aiServer: this.hostMode ? BUNDLED_SERVER_EXECUTABLE : this.installation?.paths?.serverExecutable ?? null,
        isolatedAiServer: this.compatibilityRuntime?.serverExecutable ?? null,
        opponentWindBot: this.hostMode ? null : this.installation?.paths?.windbotExecutable ?? null,
        externalPolicyWindBot: this.externalPolicyClient.executable,
        aiServerWorkingDirectory: this.compatibilityRuntime?.root ?? null,
      },
    };
  }

  getScriptErrors() {
    return findLuaScriptErrors(this.logs.get('ai-server')?.logs ?? '');
  }

  destroyDuel() {
    void this.dispose();
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.failPending(new Error('YGOPro2 duel was disposed.'));
    this.notifyHost();
    for (const socket of this.humanSockets) socket.destroy();
    if (this.publicServer) {
      await Promise.race([
        new Promise((resolvePromise) => this.publicServer.close(resolvePromise)),
        delay(1000),
      ]);
    }
    this.policySocket?.destroy();
    this.turnOrderProxySocket?.destroy();
    this.turnOrderUpstreamSocket?.destroy();
    for (const { child } of [...this.processes].reverse()) {
      if (child.exitCode === null && !child.killed) child.kill();
    }
    if (this.policyServer) {
      await Promise.race([
        new Promise((resolvePromise) => this.policyServer.close(resolvePromise)),
        delay(1000),
      ]);
    }
    if (this.turnOrderProxyServer) {
      await Promise.race([
        new Promise((resolvePromise) => this.turnOrderProxyServer.close(resolvePromise)),
        delay(1000),
      ]);
    }
    if (this.tempDirectory) await rm(this.tempDirectory, { recursive: true, force: true });
    try { this.enumerator?.destroyDuel?.(); } catch { }
  }
}

function prepareSelectedAction(decisionValue, inputValue) {
  const decision = asRecord(decisionValue);
  if (decision.terminal) return { ok: false, code: 'DUEL_TERMINAL', error: `Cannot execute an action after ${decision.reason ?? 'terminal'}.` };
  const actions = Array.isArray(decision.actions) ? decision.actions : [];
  const input = asRecord(inputValue);
  const selectionIndexes = normalizeSelectionIndexes(input.selectionIndexes);
  if (selectionIndexes) {
    if (decision.factorizedSelection !== true) return { ok: false, code: 'INVALID_FACTOR_SELECTION', error: 'selectionIndexes is only valid for a factorized decision.' };
    const constraints = asRecord(decision.selectionConstraints);
    const min = Math.max(0, Math.trunc(Number(constraints.min) || 0));
    const max = Math.max(min, Math.trunc(Number(constraints.max) || min));
    const available = Math.max(0, Math.trunc(Number(constraints.available) || 0));
    if (selectionIndexes.length < min || selectionIndexes.length > max || selectionIndexes.some((index) => index >= available)) {
      return { ok: false, code: 'INVALID_FACTOR_SELECTION', error: `Factorized selection requires ${min}-${max} unique indexes in range 0-${available - 1}.` };
    }
    const selected = selectionIndexes.map((index) => ygopro.IndexResponse(index));
    const response = decision.message.prepareResponse(selected);
    return {
      ok: true,
      action: { label: `分层选择${selectionIndexes.length}张卡片(indices=${selectionIndexes.join(',')})`, kind: 'factorized_select_card', response, text: '' },
      response,
      index: -1,
    };
  }
  let index = readIndex(input.actionIndex ?? input.index);
  if (index === null) {
    const label = readString(input.actionLabel ?? input.label);
    if (!label) return { ok: false, code: 'ACTION_REQUIRED', error: 'executeAction requires actionIndex, actionLabel, or selectionIndexes.' };
    const exact = actions.map((action, actionIndex) => ({ action, actionIndex })).filter(({ action }) => String(action?.label ?? '') === label);
    const matches = exact.length > 0 ? exact : actions.map((action, actionIndex) => ({ action, actionIndex })).filter(({ action }) => normalizeLabel(action?.label).includes(normalizeLabel(label)));
    if (matches.length !== 1) return { ok: false, code: 'ACTION_AMBIGUOUS', error: `Action label matched ${matches.length} actions; use actionIndex.`, matchingIndexes: matches.map((entry) => entry.actionIndex) };
    index = matches[0].actionIndex;
  }
  if (index < 0 || index >= actions.length) return { ok: false, code: 'ACTION_OUT_OF_RANGE', error: `Action index ${index} is out of range 0-${actions.length - 1}.` };
  const action = actions[index];
  if (action?.kind === 'factorized_select_card_candidate') return { ok: false, code: 'FACTOR_SELECTION_REQUIRED', error: 'This decision is factorized; submit selectionIndexes.' };
  const response = actionResponseBytes(action);
  if (!response) return { ok: false, code: 'ACTION_RESPONSE_MISSING', error: `Action ${index} has no protocol response.` };
  return { ok: true, action, response, index };
}

function actionResponseBytes(action) {
  if (action?.response instanceof Uint8Array || Array.isArray(action?.response)) return Uint8Array.from(action.response);
  if (typeof action?.responseBase64 === 'string') return Uint8Array.from(Buffer.from(action.responseBase64, 'base64'));
  if (Number.isInteger(action?.intResponse)) {
    const response = new Uint8Array(4);
    new DataView(response.buffer).setInt32(0, action.intResponse, true);
    return response;
  }
  return null;
}

function summarizeAction(action, index) {
  return { index, label: String(action?.label ?? `Action #${index}`), kind: String(action?.kind ?? ''), description: String(action?.text ?? '').replace(/\s+/g, ' ').slice(0, 180) };
}

// Returns the only legal action when the decision leaves no real choice;
// factorized card selections and multi-option decisions always go to the model.
export function forcedDecisionAction(value) {
  const decision = asRecord(value);
  if (decision.terminal || decision.factorizedSelection === true) return null;
  const actions = Array.isArray(decision.actions) ? decision.actions : [];
  if (actions.length !== 1) return null;
  const [action] = actions;
  if (action?.kind === 'factorized_select_card_candidate') return null;
  return actionResponseBytes(action) ? action : null;
}

function decisionName(value) {
  return asRecord(value).message?.constructor?.name ?? 'unknown';
}

function summarizeDecision(value) {
  const decision = asRecord(value);
  const actions = Array.isArray(decision.actions) ? decision.actions : [];
  return {
    terminal: Boolean(decision.terminal),
    reason: readString(decision.reason),
    decision: decision.message?.constructor?.name ?? null,
    actionCount: actions.length,
    actions: actions.slice(0, 100).map(summarizeAction),
    truncated: actions.length > 100,
    factorizedSelection: decision.factorizedSelection === true,
    estimatedLegalCandidateCount: Number.isFinite(Number(decision.estimatedLegalCandidateCount)) ? Number(decision.estimatedLegalCandidateCount) : null,
    selectionConstraints: asRecord(decision.selectionConstraints),
  };
}

function validateLaunchOptions(runner) {
  // Hosted rooms bring their own server, so only the windbot-opponent mode needs a YGOPro2 install.
  if (!runner.hostMode && !runner.installation?.capabilities?.bridgeLaunchReady) throw new Error('Selected YGOPro2 installation is not bridge-launch-ready.');
  if (!runner.externalPolicyClient?.verified) throw new Error('Verified external-policy WindBot is unavailable.');
  if (runner.playerDeck.main.length < 40) throw new Error(`YGOPro2 player deck requires at least 40 main-deck cards; received ${runner.playerDeck.main.length}.`);
  if (runner.hostMode) {
    if (!runner.cardData?.cardsDbPath || !runner.cardData?.scriptsDir) throw new Error('Hosted rooms require the plugin card database and scripts.');
    if (runner.playerTurnOrder && runner.playerTurnOrder !== 'first' && runner.playerTurnOrder !== 'second') throw new Error('modelTurnOrder must be "first", "second", or omitted.');
    return;
  }
  if (runner.playerTurnOrder !== 'first' && runner.playerTurnOrder !== 'second') throw new Error('YGOPro2 playerTurnOrder must be "first" or "second".');
  const profiles = runner.installation.opponentAiProfiles ?? [];
  if (profiles.length > 0 && !profiles.some((name) => name.toLowerCase() === runner.opponentAiProfile.toLowerCase())) {
    throw new Error(`Unknown WindBot opponent profile "${runner.opponentAiProfile}". Available profiles: ${profiles.join(', ')}.`);
  }
}

export async function prepareYgoPro2CompatibilityRuntime(installation, runtimeRoot) {
  const sourceRoot = installation?.root;
  const sourceScripts = installation?.paths?.scriptsDirectory;
  const sourceArchive = sourceRoot ? join(sourceRoot, 'data', 'script.zip') : null;
  if (!sourceRoot || !sourceScripts || !sourceArchive) {
    throw new Error('YGOPro2 compatibility runtime requires an installation root, script directory, and data/script.zip.');
  }

  let archive;
  try {
    archive = await JSZip.loadAsync(await readFile(sourceArchive));
  } catch (error) {
    throw new Error(`Unable to read the YGOPro2 script archive ${sourceArchive}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const bootstrapEntries = Object.values(archive.files)
    .filter((entry) => !entry.dir && /^script\/[^/]+\.lua$/i.test(entry.name) && !/^c\d+\.lua$/i.test(entry.name.split('/').at(-1)))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (bootstrapEntries.length === 0) {
    throw new Error(`YGOPro2 script archive ${sourceArchive} contains no bootstrap Lua scripts.`);
  }

  const archiveConstant = bootstrapEntries.find((entry) => /\/constant\.lua$/i.test(entry.name));
  if (!archiveConstant) throw new Error(`YGOPro2 script archive ${sourceArchive} contains no script/constant.lua.`);
  const installedConstantText = await readFile(join(sourceScripts, 'constant.lua'), 'utf8').catch(() => '');
  const archiveConstantText = await archiveConstant.async('string');
  const compatibilityAssignments = changedGlobalAssignments(installedConstantText, archiveConstantText);
  const compatibilityGlobals = compatibilityAssignments.map((entry) => entry.name);
  const compatibilityPrelude = compatibilityAssignments.length > 0
    ? `-- YGOagentskill: adapt archived card scripts to this AI.Server constant ABI.\n${compatibilityAssignments.map((entry) => entry.assignment).join('\n')}\n`
    : '';

  await mkdir(runtimeRoot, { recursive: true });
  const serverExecutable = join(runtimeRoot, basename(installation.paths.serverExecutable));
  await copyFile(installation.paths.serverExecutable, serverExecutable);
  const runtimeScripts = join(runtimeRoot, 'script');
  await cp(sourceScripts, runtimeScripts, { recursive: true, force: true });
  const bootstrapFiles = [];
  const replacedStaleFiles = [];
  for (const entry of bootstrapEntries) {
    const fileName = entry.name.split('/').at(-1);
    const target = join(runtimeScripts, fileName);
    const archiveBytes = await entry.async('nodebuffer');
    const installedBytes = await readFile(target).catch(() => null);
    if (!installedBytes || !installedBytes.equals(archiveBytes)) replacedStaleFiles.push(fileName);
    await writeFile(target, archiveBytes);
    bootstrapFiles.push(fileName);
  }

  let patchedScripts = await patchLuaTree(runtimeScripts, compatibilityPrelude, compatibilityGlobals, new Set(bootstrapFiles));

  const runtimeData = join(runtimeRoot, 'data');
  await cp(join(sourceRoot, 'data'), runtimeData, { recursive: true, force: true });
  for (const entry of Object.values(archive.files)) {
    if (entry.dir || !/^script\/.+\.lua$/i.test(entry.name) || /^script\/(?:constant|utility|procedure)\.lua$/i.test(entry.name)) continue;
    const source = await entry.async('nodebuffer');
    if (!scriptNeedsCompatibility(source.toString('utf8'), compatibilityGlobals)) continue;
    archive.file(entry.name, Buffer.concat([Buffer.from(compatibilityPrelude, 'utf8'), source]));
    patchedScripts += 1;
  }
  await writeFile(join(runtimeData, 'script.zip'), await archive.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  }));

  const sourceExpansions = join(sourceRoot, 'expansions');
  const runtimeExpansions = join(runtimeRoot, 'expansions');
  try {
    await cp(sourceExpansions, runtimeExpansions, { recursive: true, force: true });
    patchedScripts += await patchLuaTree(runtimeExpansions, compatibilityPrelude, compatibilityGlobals);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const resourceMappings = [];
  for (const name of ['cdb', 'config']) {
    const source = join(sourceRoot, name);
    const target = join(runtimeRoot, name);
    try {
      await linkOrCopyDirectory(source, target);
      resourceMappings.push({ name, source, target });
    } catch (error) {
      if (name === 'cdb') {
        throw new Error(`Unable to stage required YGOPro2 resource directory ${source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  await mkdir(join(runtimeRoot, 'replay'), { recursive: true });
  await mkdir(join(runtimeRoot, 'deck'), { recursive: true });
  resourceMappings.unshift(
    { name: 'data', source: join(sourceRoot, 'data'), target: runtimeData, mode: 'isolated-copy' },
    { name: 'expansions', source: sourceExpansions, target: runtimeExpansions, mode: 'isolated-copy' },
  );
  return {
    root: runtimeRoot,
    serverExecutable,
    sourceArchive,
    bootstrapFiles,
    replacedStaleFiles,
    compatibilityGlobals,
    patchedScripts,
    resourceMappings,
  };
}

function changedGlobalAssignments(installedText, archiveText) {
  const installed = globalAssignments(installedText);
  const archive = globalAssignments(archiveText);
  return archive.filter((entry) => installed.get(entry.name) !== entry.normalized);
}

function globalAssignments(text) {
  const entries = [];
  const values = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const assignment = line.split('--', 1)[0].trim();
    const match = assignment.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/);
    if (!match) continue;
    const entry = {
      name: match[1],
      assignment: `${match[1]} = ${match[2].trim()}`,
      normalized: match[2].replace(/\s+/g, ''),
    };
    entries.push(entry);
    values.set(entry.name, entry.normalized);
  }
  return Object.assign(entries, { get: (name) => values.get(name) });
}

async function patchLuaTree(root, prelude, globals, excludedBaseNames = new Set()) {
  if (!prelude || globals.length === 0) return 0;
  let patched = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      patched += await patchLuaTree(path, prelude, globals, excludedBaseNames);
      continue;
    }
    if (!entry.isFile() || !/\.lua$/i.test(entry.name) || excludedBaseNames.has(entry.name)) continue;
    const source = await readFile(path, 'utf8');
    if (!scriptNeedsCompatibility(source, globals)) continue;
    await writeFile(path, `${prelude}${source}`, 'utf8');
    patched += 1;
  }
  return patched;
}

function scriptNeedsCompatibility(source, globals) {
  return globals.some((name) => new RegExp(`\\b${name}\\b`).test(source));
}

// The integrated release ships a YGOPro2 client here; the external release does not.
export async function bundledClientExecutable() {
  try {
    return (await stat(BUNDLED_CLIENT_EXECUTABLE)).isFile() ? BUNDLED_CLIENT_EXECUTABLE : null;
  } catch {
    return null;
  }
}

// Copies the plugin's card data into the bundled client so it shows the same
// cards the server plays with. Only the bundled client is ever written.
export async function syncBundledClientCardData(clientExecutable, cardData) {
  const root = dirname(clientExecutable);
  const data = asRecord(cardData);
  const copies = [
    [data.cardsDbPath, join(root, 'cdb', 'cards.cdb')],
    [data.prereleaseReleaseDbPath, join(root, 'expansions', 'test-release.cdb')],
    [data.prereleaseUpdateDbPath, join(root, 'expansions', 'test-update.cdb')],
    [data.lflistPath, join(root, 'config', 'lflist.conf')],
  ];
  const updated = [];
  for (const [source, target] of copies) {
    if (!source) continue;
    let from;
    try { from = await stat(source); } catch { continue; }
    const to = await stat(target).catch(() => null);
    if (to && to.size === from.size && to.mtimeMs >= from.mtimeMs) continue;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    updated.push(basename(target));
  }
  return updated;
}

// Opens the YGOPro2 client and joins the hosted room. A running client polls
// commamd.shell about once a second on its menu screens; a new client gets the
// join through its -n/-h/-p/-j arguments.
export async function launchYgoPro2Client(runner, clientExecutable) {
  if (!clientExecutable) return { launched: false, reason: 'YGOPro2 client was not found; join manually.' };
  const root = dirname(clientExecutable);
  const host = runner.bindAddress === '0.0.0.0' ? '127.0.0.1' : runner.bindAddress;
  const name = await readYgoPro2PlayerName(root);
  const quoted = /\s/.test(name) ? `"${name}"` : name;
  const running = await isClientRunning(clientExecutable);
  if (running) {
    await writeFile(join(root, 'commamd.shell'), `online ${quoted} ${host} ${runner.hostPort} 0x233 `, 'utf8');
  } else {
    const child = spawn(clientExecutable, ['-n', name, '-h', host, '-p', String(runner.hostPort), '-j'], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  }
  return { launched: true, alreadyRunning: running, client: clientExecutable, playerName: name, address: `${host}:${runner.hostPort}` };
}

async function readYgoPro2PlayerName(root) {
  try {
    const text = await readFile(join(root, 'config', 'config.conf'), 'utf8');
    const match = /^name->(.+)$/m.exec(text);
    if (match && match[1].trim()) return match[1].trim();
  } catch { }
  return 'Player';
}

// Matches by full path, so the bundled client and a separate YGOPro2 install
// are told apart even though both run as YGOPro2.exe.
function isClientRunning(executable) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const name = basename(executable).replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { $_.ExecutablePath }`;
  return new Promise((resolvePromise) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
      const target = executable.toLowerCase();
      resolvePromise(!error && String(stdout).split(/\r?\n/).some((line) => line.trim().toLowerCase() === target));
    });
  });
}

export function bundledServerExecutable() {
  return BUNDLED_SERVER_EXECUTABLE;
}

// Builds an AI.Server working directory from the plugin's own card data, so a
// card-data refresh updates the hosted server without touching YGOPro2.
export async function prepareBundledServerRuntime(cardData, runtimeRoot) {
  const data = asRecord(cardData);
  if (!data.cardsDbPath || !data.scriptsDir) throw new Error('Bundled AI.Server requires the plugin cards database and script directory.');
  await mkdir(runtimeRoot, { recursive: true });
  const serverExecutable = join(runtimeRoot, basename(BUNDLED_SERVER_EXECUTABLE));
  await copyFile(BUNDLED_SERVER_EXECUTABLE, serverExecutable);
  await mkdir(join(runtimeRoot, 'cdb'), { recursive: true });
  await copyFile(data.cardsDbPath, join(runtimeRoot, 'cdb', 'cards.cdb'));
  const expansions = join(runtimeRoot, 'expansions');
  await mkdir(expansions, { recursive: true });
  const prereleaseDbs = [];
  for (const path of [data.prereleaseReleaseDbPath, data.prereleaseUpdateDbPath]) {
    if (!path) continue;
    try {
      await copyFile(path, join(expansions, basename(path)));
      prereleaseDbs.push(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  // Prerelease scripts go in an expansion archive that the server checks before ./script.
  // The prerelease base scripts (constant/utility/procedure) travel with them: the
  // prerelease card scripts depend on definitions only those newer copies provide.
  let prereleaseScripts = 0;
  if (data.prereleaseScriptsDir) {
    const archive = new JSZip();
    try {
      for (const entry of await readdir(data.prereleaseScriptsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[A-Za-z0-9_]+\.lua$/i.test(entry.name)) continue;
        archive.file(`script/${entry.name}`, await readFile(join(data.prereleaseScriptsDir, entry.name)));
        prereleaseScripts += 1;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (prereleaseScripts > 0) {
      await writeFile(join(expansions, 'dsh-prerelease-scripts.zip'), await archive.generateAsync({ type: 'nodebuffer' }));
    }
  }
  await linkOrCopyDirectory(data.scriptsDir, join(runtimeRoot, 'script'));
  await mkdir(join(runtimeRoot, 'config'), { recursive: true });
  if (data.lflistPath) {
    await copyFile(data.lflistPath, join(runtimeRoot, 'config', 'lflist.conf')).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
  await mkdir(join(runtimeRoot, 'replay'), { recursive: true });
  return {
    root: runtimeRoot,
    serverExecutable,
    sourceArchive: null,
    bootstrapFiles: [],
    replacedStaleFiles: [],
    compatibilityGlobals: [],
    patchedScripts: 0,
    resourceMappings: [
      { name: 'cdb', source: data.cardsDbPath, target: join(runtimeRoot, 'cdb', 'cards.cdb'), mode: 'copy' },
      { name: 'script', source: data.scriptsDir, target: join(runtimeRoot, 'script'), mode: 'link-or-copy' },
      { name: 'expansions', source: data.prereleaseScriptsDir ?? null, target: expansions, mode: 'prerelease', prereleaseDbs, prereleaseScripts },
    ],
    cardDatabases: [data.cardsDbPath, ...prereleaseDbs],
  };
}

async function linkOrCopyDirectory(source, target) {
  try {
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'ENOENT') throw error;
    await cp(source, target, { recursive: true, force: true });
  }
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

async function waitForListeningPort(record, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const reportedPort = new RegExp(`\\b${port}\\b`);
  while (Date.now() < deadline) {
    if (record.child.exitCode !== null) throw new Error(`AI.Server exited with code ${record.child.exitCode}: ${record.logs}`);
    if (reportedPort.test(record.logs)) return;
    await delay(50);
  }
  throw new Error(`AI.Server did not report requested port ${port} within ${timeoutMs} ms: ${record.logs}`);
}

export function findLuaScriptErrors(logText) {
  const errors = [];
  for (const rawLine of String(logText ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/\[string ["'].+?\.lua["']\]:\d+:/i.test(line) || /error loading (?:script|lua)/i.test(line)) {
      errors.push(line.slice(0, 1000));
    }
  }
  return [...new Set(errors)];
}

function policyStateToSnapshot(state) {
  return {
    p0: playerToSnapshot(state.p0),
    p1: playerToSnapshot(state.p1),
    lp: [Number(state.lp?.p0 ?? 0), Number(state.lp?.p1 ?? 0)],
    turn: Number(state.turn ?? 0),
    turnPlayer: Number(state.turnPlayer ?? 0),
    phase: phaseName(state.phase),
  };
}

function playerToSnapshot(player) {
  const record = asRecord(player);
  const cards = (value) => (Array.isArray(value) ? value : []).map((code) => ({ code: Number(code) || 0 }));
  return { hand: cards(record.hand), deck: cards(record.deck), extra: cards(record.extra), mzone: cards(record.mzone), szone: cards(record.szone), grave: cards(record.grave), banished: cards(record.banished) };
}

function normalizePolicyState(value) {
  const record = asRecord(value);
  return { p0: asRecord(record.p0), p1: asRecord(record.p1), lp: asRecord(record.lp), turn: Number(record.turn ?? 0), turnPlayer: Number(record.turnPlayer ?? 0), phase: Number(record.phase ?? 0) };
}

function emptyState() {
  const player = { hand: [], deck: [], extra: [], mzone: [], szone: [], grave: [], banished: [] };
  return { p0: player, p1: { ...player }, lp: { p0: 8000, p1: 8000 }, turn: 0, turnPlayer: 0, phase: 0 };
}

function phaseName(value) {
  const phase = Number(value);
  const names = new Map([[1, 'DRAW'], [2, 'STANDBY'], [4, 'MAIN1'], [8, 'BATTLE_START'], [16, 'BATTLE_STEP'], [32, 'DAMAGE'], [64, 'DAMAGE_CAL'], [128, 'BATTLE'], [256, 'MAIN2'], [512, 'END']]);
  return names.get(phase) ?? String(phase);
}

function cloneDeck(value) {
  const deck = asRecord(value);
  return { main: [...(deck.main ?? [])].map(Number), extra: [...(deck.extra ?? [])].map(Number), side: [...(deck.side ?? [])].map(Number) };
}

function normalizeSelectionIndexes(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const indexes = value.map(readIndex);
  return indexes.some((index) => index === null) || new Set(indexes).size !== indexes.length ? null : indexes;
}

// YGOPro chat packets carry at most 255 UTF-16 units; send long replies in parts.
function splitChat(text) {
  const chunks = [];
  for (const line of String(text).split(/\r?\n/)) {
    const characters = [...line.trim()];
    for (let at = 0; at < characters.length; at += CHAT_CHUNK_LENGTH) chunks.push(characters.slice(at, at + CHAT_CHUNK_LENGTH).join(''));
  }
  return chunks.filter(Boolean).slice(0, 20);
}

function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function normalizeLabel(value) { return String(value ?? '').replace(/\s+/g, '').toLowerCase(); }
function normalizeTimeout(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback; }
function readIndex(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : null; }
function readString(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function asRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
