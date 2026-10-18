/**
 * Collects items and hands them to `flush` in groups, either when the group is full or after a
 * short delay. One Redis round trip for a whole group costs far less than one round trip per item.
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
    this.inFlight = this.inFlight.then(() => this.flush(batch)).catch((err) => this.onError(err, batch));
  }
}
