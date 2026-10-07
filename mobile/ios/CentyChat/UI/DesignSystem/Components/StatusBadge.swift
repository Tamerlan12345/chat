import SwiftUI

/// Индикатор статуса присутствия пользователя
public struct StatusBadge: View {
    public let status: UserStatus
    public var size: CGFloat = 12
    
    public init(status: UserStatus, size: CGFloat = 12) {
        self.status = status
        self.size = size
    }
    
    public var body: some View {
        Circle()
            .fill(status.color)
            .frame(width: size, height: size)
            .overlay(
                Circle()
                    .stroke(CentyColors.card, lineWidth: max(1.5, size * 0.15))
            )
    }
}
