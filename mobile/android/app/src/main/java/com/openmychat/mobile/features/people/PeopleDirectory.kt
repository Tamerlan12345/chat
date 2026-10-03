package com.openmychat.mobile.features.people

import com.openmychat.mobile.data.model.OrgDepartment
import com.openmychat.mobile.data.model.OrgTree
import com.openmychat.mobile.data.model.User

/** Узел «Отделов»: подотделы, сотрудники отдела и счётчики «в сети / всего» по всей ветке. */
data class DepartmentNode(
    val id: Long,
    val name: String,
    val children: List<DepartmentNode>,
    val people: List<Person>,
    val total: Int,
    val online: Int
) {
    val isUnassigned: Boolean get() = id == PeopleDirectory.UNASSIGNED_ID
}

/** Раздел алфавитного списка «Все»: буква и сотрудники на неё. */
data class LetterSection(val letter: String, val people: List<Person>)

/** Правила справочника сотрудников: кого показывать, как собрать отделы, разделы и счётчики. */
object PeopleDirectory {
    const val UNASSIGNED_ID = -1L
    const val UNASSIGNED_NAME = "Без подразделения"

    /**
     * Коллеги из `/api/users`: только активные и одобренные, без самого себя, по алфавиту. Отдел
     * подписывается по дереву оргструктуры, а если отдела там нет — как прислал список.
     */
    fun people(users: List<User>, tree: OrgTree?, selfId: Long?): List<Person> {
        val names = tree?.let { departmentNames(it.tree) }.orEmpty()
        return users
            .asSequence()
            .filter { it.isActive && it.approvalStatus == "approved" && it.id != selfId }
            .map { user -> Person.from(user, departmentName = user.departmentId?.let(names::get) ?: user.departmentName) }
            .sortedWith(compareBy(NameOrder) { it.fullName })
            .toList()
    }

    fun onlineCount(people: List<Person>): Int = people.count { it.status.isReachable }

    /** Дерево отделов с сотрудниками; «Без подразделения» — последним и только если там кто-то есть. */
    fun departments(tree: OrgTree?, people: List<Person>): List<DepartmentNode> {
        val departments = tree?.tree.orEmpty()
        val known = HashSet<Long>()
        collectIds(departments, known)
        val byDepartment = people.filter { it.departmentId != null && it.departmentId in known }.groupBy { it.departmentId!! }
        val nodes = departments.map { build(it, byDepartment) }
        val unassigned = people.filter { it.departmentId == null || it.departmentId !in known }
        return if (unassigned.isEmpty()) nodes else nodes + DepartmentNode(
            id = UNASSIGNED_ID,
            name = UNASSIGNED_NAME,
            children = emptyList(),
            people = unassigned,
            total = unassigned.size,
            online = onlineCount(unassigned)
        )
    }

    /**
     * Ветки, где есть подходящие сотрудники. Отдел, чьё имя подходит под запрос, показывается со
     * всеми сотрудниками (как на настольном клиенте). «В сети» оставляет только online и away.
     * Счётчики узлов не меняются: «3/9 в сети» — про весь отдел, а не про выдачу.
     */
    fun filter(nodes: List<DepartmentNode>, query: String, onlineOnly: Boolean): List<DepartmentNode> {
        val tokens = SearchText.tokens(query)
        if (tokens.isEmpty() && !onlineOnly) return nodes
        return nodes.mapNotNull { filterNode(it, query, tokens, onlineOnly, parentMatched = false) }
    }

    /** Ид всех отделов в отфильтрованном дереве: при поиске найденные ветки раскрыты. */
    fun allIds(nodes: List<DepartmentNode>): Set<Long> {
        val ids = HashSet<Long>()
        fun walk(list: List<DepartmentNode>): Unit = list.forEach { ids += it.id; walk(it.children) }
        walk(nodes)
        return ids
    }

    /** Цепочка отделов от корня до [departmentId] (чтобы раскрыть ветку по тапу «Отдел» в карточке). */
    fun pathTo(nodes: List<DepartmentNode>, departmentId: Long): List<Long> {
        fun search(list: List<DepartmentNode>, path: List<Long>): List<Long>? {
            for (node in list) {
                val here = path + node.id
                if (node.id == departmentId) return here
                search(node.children, here)?.let { return it }
            }
            return null
        }
        return search(nodes, emptyList()).orEmpty()
    }

    fun sections(people: List<Person>): List<LetterSection> =
        people.sortedWith(compareBy(NameOrder) { it.fullName })
            .groupBy { letterOf(it.fullName) }
            .map { (letter, list) -> LetterSection(letter, list) }

    /** Буква раздела: первая буква имени («Ё» — в «Е»), не буква — «#». */
    fun letterOf(name: String): String {
        val first = name.trim().firstOrNull() ?: return "#"
        if (NameOrder.script(first) == 2) return "#"
        return SearchText.normalize(first.toString()).uppercase()
    }

    private fun filterNode(
        node: DepartmentNode,
        query: String,
        tokens: List<String>,
        onlineOnly: Boolean,
        parentMatched: Boolean
    ): DepartmentNode? {
        val name = SearchText.normalize(node.name)
        val nameMatched = parentMatched || (tokens.isNotEmpty() && tokens.all { name.contains(it) })
        val people = node.people.filter { person ->
            (!onlineOnly || person.status.isReachable) && (nameMatched || PeopleSearch.matches(person, query))
        }
        val children = node.children.mapNotNull { filterNode(it, query, tokens, onlineOnly, nameMatched) }
        val keepEmpty = nameMatched && !onlineOnly
        if (people.isEmpty() && children.isEmpty() && !keepEmpty) return null
        return node.copy(children = children, people = people)
    }

    private fun build(department: OrgDepartment, byDepartment: Map<Long, List<Person>>): DepartmentNode {
        val children = department.subDepartments.map { build(it, byDepartment) }
        val own = byDepartment[department.id].orEmpty().sortedWith(compareBy(NameOrder) { it.fullName })
        return DepartmentNode(
            id = department.id,
            name = department.name,
            children = children,
            people = own,
            total = own.size + children.sumOf { it.total },
            online = onlineCount(own) + children.sumOf { it.online }
        )
    }

    private fun collectIds(departments: List<OrgDepartment>, into: MutableSet<Long>) {
        departments.forEach {
            into += it.id
            collectIds(it.subDepartments, into)
        }
    }

    private fun departmentNames(departments: List<OrgDepartment>): Map<Long, String> {
        val names = HashMap<Long, String>()
        fun walk(list: List<OrgDepartment>): Unit = list.forEach { names[it.id] = it.name; walk(it.subDepartments) }
        walk(departments)
        return names
    }
}
