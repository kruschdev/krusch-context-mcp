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
    }

    initEndpoints() {
        const FLEET_NODES = [
            'http://10.0.0.19:11434', // kruschgame
            'http://127.0.0.1:11434', // kruschdev
            'http://10.0.0.85:11434'  // kruschserv
        ];
        // Fallback to empty if config isn't loaded correctly, but default to env or fleet
        const confUrl = process.env.OLLAMA_URL;
        return process.env.OLLAMA_NODES 
            ? process.env.OLLAMA_NODES.split(',') 
            : (confUrl ? [confUrl, ...FLEET_NODES.filter(n => n !== confUrl)] : FLEET_NODES);
    }

    getNextEndpoint() {
        const ep = this.endpoints[this.rrIndex];
        this.rrIndex = (this.rrIndex + 1) % this.endpoints.length;
        return ep;
    }

    /**
     * Enqueue a task to run against an Ollama endpoint.
     * @param {function(string): Promise<any>} taskFn - The async function to run, receives endpoint URL.
     * @param {number} priority - Lower number = higher priority.
     */
    enqueue(taskFn, priority = PRIORITY.MEDIUM) {
        return new Promise((resolve, reject) => {
            this.queue.push({ taskFn, priority, resolve, reject });
            // Re-sort queue so lowest priority number is first
            this.queue.sort((a, b) => a.priority - b.priority);
            this.process();
        });
    }

    async process() {
        if (this.active >= this.concurrency || this.queue.length === 0) return;
        this.active++;
        const item = this.queue.shift();
        
        let attempts = 0;
        const maxAttempts = this.endpoints.length;
        let success = false;
        let lastErr = null;
        
        while (attempts < maxAttempts && !success) {
            const endpoint = this.getNextEndpoint();
            try {
                const result = await item.taskFn(endpoint);
                item.resolve(result);
                success = true;
            } catch (err) {
                console.warn(`[OllamaQueue] Endpoint ${endpoint} failed: ${err.message}. Retrying...`);
                lastErr = err;
                attempts++;
            }
        }
        
        if (!success) {
            item.reject(new Error(`[OllamaQueue] All fleet nodes failed. Last error: ${lastErr?.message}`));
        }
        
        this.active--;
        // Automatically process the next task
        this.process();
    }
}

// Default concurrency allows 3 parallel requests (e.g. 1 per fleet node)
export const ollamaQueue = new PriorityQueue(process.env.OLLAMA_MAX_CONCURRENCY ? parseInt(process.env.OLLAMA_MAX_CONCURRENCY, 10) : 3);
