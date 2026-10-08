import Foundation

/// Подразделение из `GET /api/org/tree` (только то, что нужно справочнику).
/// Временно живёт в Features: перенести в Models, когда CORE добавит этот ответ в репозиторий.
public struct OrgDepartment: Codable, Sendable, Equatable, Hashable {
    public var id: Int64
    public var name: String
    public var subDepartments: [OrgDepartment]

    public init(id: Int64, name: String, subDepartments: [OrgDepartment] = []) {
        self.id = id
        self.name = name
        self.subDepartments = subDepartments
    }

    enum CodingKeys: String, CodingKey {
        case id, name, subDepartments
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int64.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        subDepartments = try container.decodeIfPresent([OrgDepartment].self, forKey: .subDepartments) ?? []
    }
}

/// `GET /api/org/tree`: корневые подразделения.
public struct OrgTree: Codable, Sendable, Equatable, Hashable {
    public var tree: [OrgDepartment]

    public init(tree: [OrgDepartment] = []) {
        self.tree = tree
    }

    enum CodingKeys: String, CodingKey {
        case tree
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tree = try container.decodeIfPresent([OrgDepartment].self, forKey: .tree) ?? []
    }
}

/// Узел «Отделов»: подотделы, сотрудники отдела и счётчики «в сети / всего» по всей ветке.
public struct DepartmentNode: Identifiable, Equatable, Sendable {
    public var id: Int64
    public var name: String
    public var children: [DepartmentNode]
    public var people: [Person]
    public var total: Int
    public var online: Int

    public var isUnassigned: Bool { id == PeopleDirectory.unassignedID }
}

/// Раздел алфавитного списка «Все»: буква и сотрудники на неё.
public struct LetterSection: Identifiable, Equatable, Sendable {
    public var letter: String
    public var people: [Person]
    public var id: String { letter }
}

/// Правила справочника сотрудников: кого показывать, как собрать отделы, разделы и счётчики.
/// Порт `PeopleDirectory` (Android).
public enum PeopleDirectory {
    public static let unassignedID: Int64 = -1
    public static let unassignedName = String(localized: "Без подразделения")

    /// Коллеги из `/api/users`: только активные, без самого себя, по алфавиту. Отдел подписывается
    /// по дереву оргструктуры, а если отдела там нет — как прислал список.
    public static func people(users: [PublicUser], tree: OrgTree?, selfId: Int64?) -> [Person] {
        let names = tree.map { departmentNames($0.tree) } ?? [:]
        return users
            .filter { $0.isActive && $0.id != selfId }
            .map { user in
                let named = user.departmentId.flatMap { names[$0] } ?? user.departmentName
                return Person.from(user, departmentName: .some(named))
            }
            .sorted(by: NameOrder.precedes)
    }

    /// Подпись отдела по дереву для одного сотрудника (своя карточка, свежая карточка коллеги).
    public static func departmentName(for departmentId: Int64?, in tree: OrgTree?) -> String? {
        guard let departmentId, let tree else { return nil }
        return departmentNames(tree.tree)[departmentId]
    }

    public static func onlineCount(_ people: [Person]) -> Int {
        people.filter { $0.status.isReachable }.count
    }

    /// Дерево отделов с сотрудниками; «Без подразделения» — последним и только если там кто-то есть.
    public static func departments(tree: OrgTree?, people: [Person]) -> [DepartmentNode] {
        let departments = tree?.tree ?? []
        var known = Set<Int64>()
        collectIDs(departments, into: &known)
        var byDepartment: [Int64: [Person]] = [:]
        var unassigned: [Person] = []
        for person in people {
            if let id = person.departmentId, known.contains(id) {
                byDepartment[id, default: []].append(person)
            } else {
                unassigned.append(person)
            }
        }
        var nodes = departments.map { build($0, byDepartment: byDepartment) }
        if !unassigned.isEmpty {
            nodes.append(DepartmentNode(
                id: unassignedID,
                name: unassignedName,
                children: [],
                people: unassigned,
                total: unassigned.count,
                online: onlineCount(unassigned)
            ))
        }
        return nodes
    }

    /// Ветки, где есть подходящие сотрудники. Отдел, чьё имя подходит под запрос, показывается со
    /// всеми сотрудниками (как на настольном клиенте). «В сети» оставляет только online и away.
    /// Счётчики узлов не меняются: «3/9 в сети» — про весь отдел, а не про выдачу.
    public static func filter(_ nodes: [DepartmentNode], query: String, onlineOnly: Bool) -> [DepartmentNode] {
        let tokens = SearchText.tokens(query)
        if tokens.isEmpty && !onlineOnly { return nodes }
        return nodes.compactMap { filterNode($0, query: query, tokens: tokens, onlineOnly: onlineOnly, parentMatched: false) }
    }

    /// Ид всех отделов в отфильтрованном дереве: при поиске найденные ветки раскрыты.
    public static func allIDs(_ nodes: [DepartmentNode]) -> Set<Int64> {
        var ids = Set<Int64>()
        func walk(_ list: [DepartmentNode]) {
            for node in list {
                ids.insert(node.id)
                walk(node.children)
            }
        }
        walk(nodes)
        return ids
    }

    /// Цепочка отделов от корня до `departmentId` (чтобы раскрыть ветку по тапу «Отдел» в карточке).
    public static func path(to departmentId: Int64, in nodes: [DepartmentNode]) -> [Int64] {
        func search(_ list: [DepartmentNode], _ path: [Int64]) -> [Int64]? {
            for node in list {
                let here = path + [node.id]
                if node.id == departmentId { return here }
                if let found = search(node.children, here) { return found }
            }
            return nil
        }
        return search(nodes, []) ?? []
    }

    public static func sections(_ people: [Person]) -> [LetterSection] {
        var sections: [LetterSection] = []
        for person in people.sorted(by: NameOrder.precedes) {
            let letter = letterOf(person.fullName)
            if let last = sections.indices.last, sections[last].letter == letter {
                sections[last].people.append(person)
            } else if let index = sections.firstIndex(where: { $0.letter == letter }) {
                sections[index].people.append(person)
            } else {
                sections.append(LetterSection(letter: letter, people: [person]))
            }
        }
        return sections
    }

    /// Буква раздела: первая буква имени («Ё» — в «Е»), не буква — «#».
    public static func letterOf(_ name: String) -> String {
        guard let first = name.trimmingCharacters(in: .whitespacesAndNewlines).first else { return "#" }
        if NameOrder.script(first) == 2 { return "#" }
        return SearchText.normalize(String(first)).uppercased()
    }

    private static func filterNode(
        _ node: DepartmentNode,
        query: String,
        tokens: [String],
        onlineOnly: Bool,
        parentMatched: Bool
    ) -> DepartmentNode? {
        let name = SearchText.normalize(node.name)
        let nameMatched = parentMatched || (!tokens.isEmpty && tokens.allSatisfy { name.contains($0) })
        let people = node.people.filter { person in
            (!onlineOnly || person.status.isReachable) && (nameMatched || PeopleSearch.matches(person, query: query))
        }
        let children = node.children.compactMap {
            filterNode($0, query: query, tokens: tokens, onlineOnly: onlineOnly, parentMatched: nameMatched)
        }
        let keepEmpty = nameMatched && !onlineOnly
        if people.isEmpty && children.isEmpty && !keepEmpty { return nil }
        var copy = node
        copy.children = children
        copy.people = people
        return copy
    }

    private static func build(_ department: OrgDepartment, byDepartment: [Int64: [Person]]) -> DepartmentNode {
        let children = department.subDepartments.map { build($0, byDepartment: byDepartment) }
        let own = (byDepartment[department.id] ?? []).sorted(by: NameOrder.precedes)
        return DepartmentNode(
            id: department.id,
            name: department.name,
            children: children,
            people: own,
            total: own.count + children.reduce(0) { $0 + $1.total },
            online: onlineCount(own) + children.reduce(0) { $0 + $1.online }
        )
    }

    private static func collectIDs(_ departments: [OrgDepartment], into ids: inout Set<Int64>) {
        for department in departments {
            ids.insert(department.id)
            collectIDs(department.subDepartments, into: &ids)
        }
    }

    private static func departmentNames(_ departments: [OrgDepartment]) -> [Int64: String] {
        var names: [Int64: String] = [:]
        func walk(_ list: [OrgDepartment]) {
            for department in list {
                names[department.id] = department.name
                walk(department.subDepartments)
            }
        }
        walk(departments)
        return names
    }
}
