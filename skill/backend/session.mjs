export function createPortableSession(initial = {}) {
  return {
    metadata: { ...(initial.metadata || {}) },
    messages: Array.isArray(initial.messages) ? initial.messages.slice() : [],
    runner: initial.runner || null,
    appendMessage(role, content, metadata = {}) {
      this.messages.push({ role, content, metadata, createdAt: new Date().toISOString() });
    },
    mergeMetadata(next = {}) {
      this.metadata = { ...this.metadata, ...next };
      return this.metadata;
    },
    getModelContext() {
      return this.messages.map(({ role, content }) => ({ role, content }));
    },
  };
}
