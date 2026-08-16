// swift-tools-version: 6.0
import PackageDescription

// HuddleCore — the decision engine, isolated as a local package.
//
// This module owns rules and facts: the room state machine, domain types,
// and the CandidateProvider contract. It must never import SwiftUI or know
// any content domain (cuisine, price, ...). That isolation is enforced here:
// this package declares zero dependencies, so a stray `import SwiftUI` or
// `candidate.cuisine` is a compile error, not a code-review catch.
let package = Package(
    name: "HuddleCore",
    platforms: [
        .iOS(.v17),
        // macOS listed so `swift test` runs straight from the CLI,
        // without booting a simulator.
        .macOS(.v14),
    ],
    products: [
        .library(name: "HuddleCore", targets: ["HuddleCore"])
    ],
    targets: [
        .target(name: "HuddleCore"),
        .testTarget(name: "HuddleCoreTests", dependencies: ["HuddleCore"]),
    ],
    swiftLanguageModes: [.v6]
)
