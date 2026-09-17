/**
 * @module llm-queue
 * Priority queue for Ollama fleet inference requests.
 * Prevents homelab fleet from being overwhelmed by batch tasks while prioritizing real-time agents.
 */

export const PRIORITY = {
    CRITICAL: 0, // Real-time UI / active IDE session
    HIGH: 1,     // Interactive agent
    MEDIUM: 2,   // Background agent processing
    LOW: 3       // Bulk embeddings / offline tasks
};

class PriorityQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.active = 0;
        this.queue = [];
        this.endpoints = this.initEndpoints();
        this.rrIndex = 0;
        /** @type {Map<string, { successes: number, failures: number, lastFailAt: number }>} */
        this.stats = new Map();
        this.COOLDOWN_MS = 30_000; // Skip failed endpoints for 30s
        for (const ep of this.endpoints) {
            this.stats.set(ep, { successes: 0, failures: 0, lastFailAt: 0 });
        }
    }

    initEndpoints() {
        const FLEET_NODES = [
            'http://localhost:11434',
            'http://kruschserv:11434',
            'http://kruschgame:11434'
        ];
        const confUrl = process.env.OLLAMA_URL;
        return process.env.OLLAMA_NODES 
            ? process.env.OLLAMA_NODES.split(',') 
            : (confUrl ? [confUrl, ...FLEET_NODES.filter(n => n !== confUrl)] : FLEET_NODES);
    }

    /**
     * Get the next endpoint, preferring healthy ones (circuit breaker).
     */
    getNextEndpoint() {
        const now = Date.now();
        for (let i = 0; i < this.endpoints.length; i++) {
            const idx = (this.rrIndex + i) % this.endpoints.length;
            const ep = this.endpoints[idx];
            const stat = this.stats.get(ep);
            if (!stat || (now - stat.lastFailAt) > this.COOLDOWN_MS) {
                this.rrIndex = (idx + 1) % this.endpoints.length;
                return ep;
            }
        }
        const ep = this.endpoints[this.rrIndex];
        this.rrIndex = (this.rrIndex + 1) % this.endpoints.length;
        return ep;
    }

    recordSuccess(endpoint) {
        const s = this.stats.get(endpoint);
        if (s) { s.successes++; s.lastFailAt = 0; }
    }

    recordFailure(endpoint) {
        const s = this.stats.get(endpoint);
        if (s) { s.failures++; s.lastFailAt = Date.now(); }
    }

    health() {
        const now = Date.now();
        return this.endpoints.map(ep => {
            const s = this.stats.get(ep) || { successes: 0, failures: 0, lastFailAt: 0 };
            return { endpoint: ep, successes: s.successes, failures: s.failures, healthy: (now - s.lastFailAt) > this.COOLDOWN_MS };
        });
    }

    enqueue(taskFn, priority = PRIORITY.MEDIUM) {
        return new Promise((resolve, reject) => {
            const taskId = Math.random().toString(36).substring(2, 9);
            const queuedAt = Date.now();
            if (priority <= PRIORITY.HIGH) {
                console.error(`[OllamaQueue] 📥 Enqueued task ${taskId} (Priority: ${priority}, Active: ${this.active}, Pending: ${this.queue.length})`);
            }
            
            this.queue.push({ taskFn, priority, resolve, reject, taskId, queuedAt });
            this.queue.sort((a, b) => a.priority - b.priority);
            this.process();
        });
    }

    async process() {
        if (this.queue.length === 0) return;
        
        const nextItem = this.queue[0];
        const effectiveConcurrency = nextItem.priority <= PRIORITY.HIGH ? this.concurrency + 1 : this.concurrency;
        
        if (this.active >= effectiveConcurrency) return;
        
        try {
            this.active++;
            const item = this.queue.shift();
            
            if (item.priority <= PRIORITY.HIGH) {
                console.error(`[OllamaQueue] 🚀 Starting task ${item.taskId} (Priority: ${item.priority}, Wait time: ${Date.now() - item.queuedAt}ms)`);
            }
            
            let attempts = 0;
            const maxAttempts = this.endpoints.length;
            let success = false;
            let lastErr = null;
            
            while (attempts < maxAttempts && !success) {
                const endpoint = this.getNextEndpoint();
                try {
                    const result = await item.taskFn(endpoint);
                    this.recordSuccess(endpoint);
                    item.resolve(result);
                    success = true;
                } catch (err) {
                    this.recordFailure(endpoint);
                    const stat = this.stats.get(endpoint);
                    if (stat && stat.failures <= 3) {
                        console.warn(`[OllamaQueue] Endpoint ${endpoint} failed: ${err.message}. Retrying...`);
                    }
                    lastErr = err;
                    attempts++;
                }
            }
            
            if (!success) {
                item.reject(new Error(`[OllamaQueue] All fleet nodes failed. Last error: ${lastErr?.message}`));
            }
            
            if (item.priority <= PRIORITY.HIGH) {
                console.error(`[OllamaQueue] ✅ Completed task ${item.taskId} (Success: ${success}, Total time: ${Date.now() - item.queuedAt}ms)`);
            }
        } finally {
            this.active--;
            this.process();
        }
    }
}

export const ollamaQueue = new PriorityQueue(process.env.OLLAMA_MAX_CONCURRENCY ? parseInt(process.env.OLLAMA_MAX_CONCURRENCY, 10) : 3);
