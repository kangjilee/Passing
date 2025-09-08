export class RateLimiter {
  private queue: (() => Promise<any>)[] = [];
  private running = 0;
  private lastRequest = 0;

  constructor(
    private concurrency: number,
    private qps: number // queries per second
  ) {}

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequest;
    const minInterval = 1000 / this.qps; // ms between requests

    if (timeSinceLastRequest < minInterval) {
      const delay = minInterval - timeSinceLastRequest;
      setTimeout(() => this.process(), delay);
      return;
    }

    const task = this.queue.shift();
    if (!task) return;

    this.running++;
    this.lastRequest = Date.now();

    try {
      await task();
    } finally {
      this.running--;
      process.nextTick(() => this.process());
    }
  }

  async waitForCompletion(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  getStats() {
    return {
      queue: this.queue.length,
      running: this.running,
      concurrency: this.concurrency,
      qps: this.qps
    };
  }
}