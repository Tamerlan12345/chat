// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CentyChat",
    defaultLocalization: "ru",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .library(
            name: "CentyChat",
            targets: ["CentyChat"]
        ),
    ],
    targets: [
        .target(
            name: "CentyChat",
            path: "CentyChat",
            resources: [
                .process("Resources")
            ]
        ),
        .testTarget(
            name: "CentyChatTests",
            dependencies: ["CentyChat"],
            path: "CentyChatTests"
        ),
    ],
    swiftLanguageModes: [.v6]
)
