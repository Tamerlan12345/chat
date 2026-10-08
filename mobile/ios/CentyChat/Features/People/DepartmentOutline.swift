import Foundation

/// One row of «Отделы»: a department (with its disclosure state) or a person under it.
public struct OutlineRow: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case department(DepartmentNode, expanded: Bool)
        case person(Person)
    }

    public var kind: Kind
    public var depth: Int
    public var id: String

    /// Compact form for tests: «d1@0+» (department 1, depth 0, expanded), «p8@2» (person 8).
    public var debugDescription: String {
        switch kind {
        case .department(let node, expanded: let expanded): return "d\(node.id)@\(depth)\(expanded ? "+" : "-")"
        case .person(let person): return "p\(person.id)@\(depth)"
        }
    }
}

/// The org tree as a flat list of rows: sub-departments first, then the department's people,
/// indented one level deeper. Collapsed departments hide their whole branch.
public enum DepartmentOutline {
    public static func rows(_ nodes: [DepartmentNode], expanded: Set<Int64>) -> [OutlineRow] {
        var rows: [OutlineRow] = []
        append(nodes, expanded: expanded, depth: 0, into: &rows)
        return rows
    }

    private static func append(_ nodes: [DepartmentNode], expanded: Set<Int64>, depth: Int, into rows: inout [OutlineRow]) {
        for node in nodes {
            let open = expanded.contains(node.id)
            rows.append(OutlineRow(kind: .department(node, expanded: open), depth: depth, id: "d\(node.id)"))
            guard open else { continue }
            append(node.children, expanded: expanded, depth: depth + 1, into: &rows)
            for person in node.people {
                // The same person can sit in two places (a department and «Без подразделения»).
                rows.append(OutlineRow(kind: .person(person), depth: depth + 1, id: "p\(node.id)-\(person.id)"))
            }
        }
    }
}
