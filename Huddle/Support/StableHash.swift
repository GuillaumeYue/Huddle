/// FNV-1a — a stable string hash.
///
/// Swift's `hashValue` is seeded per launch (deliberately, against
/// hash-flooding), so anything that must look the same across launches
/// and across devices — card palettes, participant colors — needs a
/// stable hash instead. Same input, same output, forever, everywhere.
enum FNV1a {
    static func hash(_ string: String) -> UInt64 {
        var h: UInt64 = 0xcbf29ce484222325
        for byte in string.utf8 {
            h ^= UInt64(byte)
            h &*= 0x100000001b3
        }
        return h
    }
}
