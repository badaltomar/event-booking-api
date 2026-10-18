const RETRY_DELAYS_MS = [200, 1_000, 3_000];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Collects items and hands them to `flush` in groups, either when the group is full or after a
 * short delay. One Redis round trip for a whole group costs far less than one round trip per item.
 * A group that fails to send is retried a few times before it is reported through `onError`.
 */
export class Batcher<T> {
  private items: T[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly flush: (items: T[]) => Promise<void>,
    private readonly onError: (err: unknown, items: T[]) => void,
    private readonly maxDelayMs = 20,
    private readonly maxSize = 500,
  ) {}

  add(item: T): void {
    this.items.push(item);
    if (this.items.length >= this.maxSize) {
      this.drain();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.drain(), this.maxDelayMs);
    }
  }

  /** Sends whatever is buffered and waits for every send in progress. Call on shutdown. */
  async close(): Promise<void> {
    this.drain();
    await this.inFlight;
  }

  private drain(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.items.length === 0) return;

    const batch = this.items;
    this.items = [];
    this.inFlight = this.inFlight.then(() => this.send(batch));
  }

  private async send(batch: T[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.flush(batch);
        return;
      } catch (err) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          this.onError(err, batch);
          return;
        }
        await wait(delay);
      }
    }
  }
}
