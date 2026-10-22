// Per-stop records in one indexed binary file (catchments.bin, access.bin): fetch the
// file's index once, then only the wanted stop's bytes with an HTTP range request, like
// PMTiles. Layout (pipeline/src/transit/export.py, _write_indexed):
//   magic (4 bytes) | u16 version | u32 index length | index JSON | records
// where the index has "stops": id -> [byte offset, byte length], and each record is raw
// deflate.

const HEADER_BYTES = 10

export class IndexedFile<I extends { stops: Record<string, [number, number]> }> {
  /** If the server ignores Range (HTTP 200), keep the whole file and slice it instead. */
  private wholeFile: Promise<ArrayBuffer> | null = null
  private index: Promise<I> | null = null

  constructor(
    private readonly url: () => string,
    private readonly name: string,
    private readonly magic: string,
  ) {}

  private async fetchRange(start: number, length: number): Promise<ArrayBuffer> {
    if (this.wholeFile) {
      return (await this.wholeFile).slice(start, start + length)
    }
    const res = await fetch(this.url(), {
      headers: { Range: `bytes=${String(start)}-${String(start + length - 1)}` },
    })
    if (res.status === 206) {
      return res.arrayBuffer()
    }
    if (!res.ok) {
      throw new Error(`${this.name}: HTTP ${String(res.status)}`)
    }
    this.wholeFile = res.arrayBuffer()
    return (await this.wholeFile).slice(start, start + length)
  }

  loadIndex(): Promise<I> {
    if (!this.index) {
      this.index = (async () => {
        const head = new DataView(await this.fetchRange(0, HEADER_BYTES))
        const magic = String.fromCharCode(...[0, 1, 2, 3].map((i) => head.getUint8(i)))
        if (magic !== this.magic) {
          throw new Error(`${this.name}: unexpected file type`)
        }
        const length = head.getUint32(6, true)
        const json = new TextDecoder().decode(await this.fetchRange(HEADER_BYTES, length))
        return JSON.parse(json) as I
      })()
      this.index.catch(() => {
        this.index = null
      })
    }
    return this.index
  }

  /** The stop's inflated record, or null if the file has none for it. */
  async record(id: string): Promise<Uint8Array | null> {
    const idx = await this.loadIndex()
    if (!(id in idx.stops)) {
      return null
    }
    const [offset, length] = idx.stops[id]
    return inflate(await this.fetchRange(offset, length))
  }
}

async function inflate(data: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Reads unsigned LEB128 varints (7 bits per byte, high bit = more follow). */
export class Reader {
  pos = 0
  constructor(private readonly bytes: Uint8Array) {}
  uint(): number {
    let n = 0
    let shift = 0
    for (;;) {
      const b = this.bytes[this.pos++]
      // Multiplication, not <<: values can pass 2^31.
      n += (b & 0x7f) * 2 ** shift
      if (b < 0x80) {
        return n
      }
      shift += 7
    }
  }
  /** Zigzag-decoded signed varint. */
  int(): number {
    const u = this.uint()
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2
  }
  byte(): number {
    return this.bytes[this.pos++]
  }
}
