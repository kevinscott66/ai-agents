import Foundation

// API.swift зовёт туннель OpenFlux и вне `#if os(iOS)`: в ветке catch сетевого
// сбоя. Настоящий FluxNetwork тянет C-рантайм и Network, на macOS-runner его
// нет. Туннеля здесь нет — значит, и сбоев туннеля не бывает.
enum FluxNetwork {
    static func isTunnelFailure(_ error: Error, generation used: Int?) -> Bool { false }
    static func dropTunnel(generation used: Int?) async {}
}
