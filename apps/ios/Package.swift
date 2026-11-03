// swift-tools-version:5.9
import PackageDescription

// The app's logic that does not need UIKit: the inbox rule, the API client and links. The iOS app target
// (project.yml) builds these same files; `swift test` checks them on a Mac without Xcode.
let package = Package(
    name: "AEEISCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "AEEISCore", targets: ["AEEISCore"])],
    targets: [
        .target(name: "AEEISCore"),
        .testTarget(name: "AEEISCoreTests", dependencies: ["AEEISCore"]),
    ]
)
