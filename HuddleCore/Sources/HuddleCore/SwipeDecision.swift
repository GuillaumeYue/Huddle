/// A participant's verdict on one candidate.
///
/// "Swipe left / swipe right" is presentation vocabulary and stays in the
/// app layer; the engine (and later the wire protocol, and the tally that
/// counts these) only knows YES / NO. Raw values are the wire format.
public enum SwipeDecision: String, Codable, Sendable, CaseIterable {
    case yes = "YES"
    case no = "NO"
}
