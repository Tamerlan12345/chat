import SwiftUI

/// Строка корпоративного канала в списке чатов
public struct ChannelRowView: View {
    public let channel: Channel
    
    public init(channel: Channel) {
        self.channel = channel
    }
    
    private var formattedTime: String {
        guard let time = channel.lastMessageTime else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(time) {
            let formatter = DateFormatter()
            formatter.dateFormat = "HH:mm"
            return formatter.string(from: time)
        } else {
            let formatter = DateFormatter()
            formatter.dateFormat = "dd.MM"
            return formatter.string(from: time)
        }
    }
    
    public var body: some View {
        HStack(spacing: 12) {
            // Иконка канала
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(CentyColors.primarySoft)
                    .frame(width: 48, height: 48)
                
                Image(systemName: channel.type == .private ? "lock.fill" : "number")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(CentyColors.accentText)
            }
            
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(channel.name)
                        .font(.body.weight(channel.unreadCount > 0 ? .semibold : .medium))
                        .lineLimit(1)
                    
                    Spacer()
                    
                    Text(formattedTime)
                        .font(.caption.weight(channel.unreadCount > 0 ? .semibold : .regular))
                        .foregroundColor(channel.unreadCount > 0 ? CentyColors.accentText : .secondary)
                }
                
                HStack {
                    Text(channel.lastMessageText ?? channel.topic ?? String(localized: "Канал"))
                        .font(.subheadline)
                        .foregroundColor(channel.unreadCount > 0 ? .primary : .secondary)
                        .lineLimit(1)
                    
                    Spacer()
                    
                    if channel.unreadCount > 0 {
                        Text("\(channel.unreadCount)")
                            .font(.caption2.weight(.bold))
                            .foregroundColor(.white)
                            .frame(minWidth: 20, minHeight: 20)
                            .background(CentyColors.primaryBlue)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 8)
    }
}
