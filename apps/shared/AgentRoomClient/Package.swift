// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "AgentRoomClient",
    platforms: [
        .macOS(.v14),
        .visionOS(.v1)
    ],
    products: [
        .library(
            name: "AgentRoomClient",
            targets: ["AgentRoomClient"]
        )
    ],
    targets: [
        .target(name: "AgentRoomClient"),
        .testTarget(
            name: "AgentRoomClientTests",
            dependencies: ["AgentRoomClient"]
        )
    ]
)
