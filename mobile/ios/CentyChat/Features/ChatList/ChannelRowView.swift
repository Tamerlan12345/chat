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
                Circle()
                    .fill(Color(uiColor: .tertiarySystemFill))
                    .frame(width: 50, height: 50)
                
                Image(systemName: channel.type == .private ? "lock.fill" : "number")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(CentyColors.primaryBlue)
            }
            
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(channel.name)
                        .font(.system(size: 16, weight: .semibold))
                        .lineLimit(1)
                    
                    Spacer()
                    
                    Text(formattedTime)
                        .font(.caption2)
                        .foregroundColor(channel.unreadCount > 0 ? CentyColors.primaryBlue : .secondary)
                }
                
                HStack {
                    Text(channel.lastMessageText ?? (channel.topic ?? "Канал"))
                        .font(.subheadline)
                        .foregroundColor(channel.unreadCount > 0 ? Color(uiColor: .label) : .secondary)
                        .lineLimit(2)
                    
                    Spacer()
                    
                    if channel.unreadCount > 0 {
                        Text("\(channel.unreadCount)")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(CentyColors.primaryBlue)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}
