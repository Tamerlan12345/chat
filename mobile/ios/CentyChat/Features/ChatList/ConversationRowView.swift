import SwiftUI

/// Строка личного диалога в списке чатов
public struct ConversationRowView: View {
    public let conversation: DirectConversation
    
    public init(conversation: DirectConversation) {
        self.conversation = conversation
    }
    
    private var formattedTime: String {
        guard let time = conversation.lastMessageTime else { return "" }
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
            AvatarView(
                name: conversation.fullName,
                avatarUrl: conversation.avatarUrl,
                status: conversation.status,
                size: 48
            )
            
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(conversation.fullName)
                        .font(.body.weight(conversation.unreadCount > 0 ? .semibold : .medium))
                        .lineLimit(1)
                    
                    Spacer()
                    
                    Text(formattedTime)
                        .font(.caption.weight(conversation.unreadCount > 0 ? .semibold : .regular))
                        .foregroundColor(conversation.unreadCount > 0 ? CentyColors.accentText : .secondary)
                }
                
                HStack {
                    Text(conversation.lastMessageText ?? String(localized: "Нет сообщений"))
                        .font(.subheadline)
                        .foregroundColor(conversation.unreadCount > 0 ? .primary : .secondary)
                        .lineLimit(1)
                    
                    Spacer()
                    
                    if conversation.unreadCount > 0 {
                        Text("\(conversation.unreadCount)")
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
