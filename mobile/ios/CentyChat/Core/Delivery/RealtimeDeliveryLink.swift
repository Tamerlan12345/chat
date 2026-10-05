import Foundation

/// The app's WebSocket (`RealtimeRepository`) as the delivery engine's link.
struct RealtimeDeliveryLink: DeliveryLink {
    let repository: any RealtimeRepository

    func send(_ frame: JSONObject) async -> Bool {
        await repository.sendFrame(frame)
    }

    func restart() async {
        await repository.restartLink()
    }

    func authenticatedUserId() async -> Int64? {
        await repository.authenticatedUserId()
    }
}
