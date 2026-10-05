import Foundation
import Network

/// Tells when the device gets a usable network path again (`NWPathMonitor`): the queue then goes
/// out without waiting for the socket's backoff.
@MainActor
final class NetworkPathWatcher {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "kz.centras.centychat.network-path")
    private var wasSatisfied: Bool?
    private var started = false

    /// `onAvailable` runs on the main actor after each transition to a satisfied path.
    func start(onAvailable: @escaping @MainActor @Sendable () -> Void) {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                let previous = self.wasSatisfied
                self.wasSatisfied = satisfied
                if satisfied && previous == false { onAvailable() }
            }
        }
        monitor.start(queue: queue)
    }
}
