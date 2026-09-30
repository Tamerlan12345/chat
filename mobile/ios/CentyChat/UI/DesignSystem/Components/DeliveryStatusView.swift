import SwiftUI

/// Индикатор статуса доставки и прочтения сообщения
public struct DeliveryStatusView: View {
    public let status: DeliveryStatus?
    public var isOutgoing: Bool
    
    public init(status: DeliveryStatus?, isOutgoing: Bool = true) {
        self.status = status
        self.isOutgoing = isOutgoing
    }
    
    public var body: some View {
        guard isOutgoing, let status = status else {
            return AnyView(EmptyView())
        }
        
        return AnyView(
            HStack(spacing: -3) {
                switch status {
                case .sending:
                    Image(systemName: "clock")
                        .font(.system(size: 10))
                        .foregroundColor(.white.opacity(0.8))
                    
                case .sent, .delivered:
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.white.opacity(0.85))
                    
                case .read:
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.white)
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.white)
                }
            }
        )
    }
}
