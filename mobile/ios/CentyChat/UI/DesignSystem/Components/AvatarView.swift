import SwiftUI

/// Круглый аватар пользователя с инициалами или фото, и опциональным статусом присутствия
public struct AvatarView: View {
    public let name: String
    public let avatarUrl: String?
    public var status: UserStatus? = nil
    public var size: CGFloat = 44
    
    public init(name: String, avatarUrl: String? = nil, status: UserStatus? = nil, size: CGFloat = 44) {
        self.name = name
        self.avatarUrl = avatarUrl
        self.status = status
        self.size = size
    }
    
    private var initials: String {
        let parts = name.split(separator: " ").filter { !$0.isEmpty }
        if parts.count >= 2 {
            let first = parts[0].prefix(1)
            let second = parts[1].prefix(1)
            return "\(first)\(second)".uppercased()
        } else if let firstPart = parts.first {
            return String(firstPart.prefix(2)).uppercased()
        }
        return "?"
    }
    
    private var backgroundGradient: LinearGradient {
        let hash = abs(name.hashValue)
        let colors: [[Color]] = [
            [Color.blue, Color.cyan],
            [Color.indigo, Color.purple],
            [Color.orange, Color.red],
            [Color.teal, Color.green],
            [Color.pink, Color.orange]
        ]
        let pair = colors[hash % colors.count]
        return LinearGradient(colors: pair, startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    
    public var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let avatarUrl = avatarUrl, !avatarUrl.isEmpty {
                    if avatarUrl.starts(with: "data:image"),
                       let commaIdx = avatarUrl.firstIndex(of: ","),
                       let data = Data(base64Encoded: String(avatarUrl[avatarUrl.index(after: commaIdx)...])),
                       let uiImage = UIImage(data: data) {
                        Image(uiImage: uiImage)
                            .resizable()
                            .scaledToFill()
                    } else if let url = URL(string: avatarUrl) {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let image):
                                image.resizable().scaledToFill()
                            default:
                                initialsView
                            }
                        }
                    } else {
                        initialsView
                    }
                } else {
                    initialsView
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            
            if let status = status {
                StatusBadge(status: status, size: max(10, size * 0.28))
                    .offset(x: 2, y: 2)
            }
        }
    }
    
    private var initialsView: some View {
        ZStack {
            backgroundGradient
            Text(initials)
                .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                .foregroundColor(.white)
        }
    }
}

/// Skeleton.
enum AvatarPalette {
    static func colorHex(for name: String) -> UInt32 { 0 }
    static func initials(of name: String) -> String { "" }
}
