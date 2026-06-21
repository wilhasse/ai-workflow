// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "AiWorkflowNative",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(name: "AiWorkflowNative", targets: ["AiWorkflowNative"]),
  ],
  targets: [
    .executableTarget(name: "AiWorkflowNative"),
  ]
)
