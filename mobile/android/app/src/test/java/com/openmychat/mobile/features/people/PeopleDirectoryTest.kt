package com.openmychat.mobile.features.people

import com.openmychat.mobile.data.model.OrgDepartment
import com.openmychat.mobile.data.model.OrgTree
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PeopleDirectoryTest {

    private fun user(
        id: Long,
        name: String,
        departmentId: Long? = null,
        departmentName: String? = null,
        status: UserStatus = UserStatus.OFFLINE,
        active: Boolean = true,
        approval: String = "approved"
    ) = User(
        id = id, username = "u$id", fullName = name, departmentId = departmentId, departmentName = departmentName,
        status = status, isActive = active, approvalStatus = approval
    )

    private val tree = OrgTree(
        tree = listOf(
            OrgDepartment(
                id = 1, name = "Головной офис",
                subDepartments = listOf(
                    OrgDepartment(id = 2, name = "Бухгалтерия"),
                    OrgDepartment(id = 3, name = "ИТ")
                )
            ),
            OrgDepartment(id = 4, name = "Филиал")
        )
    )

    @Test
    fun onlyActiveApprovedColleaguesAreListedAndNeverYourself() {
        val people = PeopleDirectory.people(
            users = listOf(
                user(1, "Я Сам"),
                user(2, "Активный Коллега"),
                user(3, "Уволенный Коллега", active = false),
                user(4, "Ждущий Одобрения", approval = "pending")
            ),
            tree = null,
            selfId = 1
        )
        assertEquals(listOf(2L), people.map { it.id })
    }

    @Test
    fun departmentNamesComeFromTheTreeWhenTheListLacksThem() {
        val people = PeopleDirectory.people(
            users = listOf(user(2, "Бух Галтер", departmentId = 2), user(3, "Без Отдела", departmentName = "Старое имя")),
            tree = tree,
            selfId = 1
        )
        assertEquals("Бухгалтерия", people.first { it.id == 2L }.departmentName)
        assertEquals("Старое имя", people.first { it.id == 3L }.departmentName)
    }

    @Test
    fun onlineMeansOnlineOrAwayLikeTheDesktop() {
        assertTrue(UserStatus.ONLINE.isReachable)
        assertTrue(UserStatus.AWAY.isReachable)
        assertFalse(UserStatus.DND.isReachable)
        assertFalse(UserStatus.OFFLINE.isReachable)
        val people = PeopleDirectory.people(
            users = listOf(
                user(2, "А", status = UserStatus.ONLINE),
                user(3, "Б", status = UserStatus.AWAY),
                user(4, "В", status = UserStatus.DND),
                user(5, "Г")
            ),
            tree = null,
            selfId = 1
        )
        assertEquals(2, PeopleDirectory.onlineCount(people))
    }

    @Test
    fun theTreeHoldsPeopleUnderTheirDepartmentsWithCountsAndUnassignedLast() {
        val people = PeopleDirectory.people(
            users = listOf(
                user(2, "Бух Один", departmentId = 2, status = UserStatus.ONLINE),
                user(3, "Бух Два", departmentId = 2),
                user(4, "Айти Один", departmentId = 3, status = UserStatus.AWAY),
                user(5, "Директор", departmentId = 1),
                user(6, "Потерянный", departmentId = 99)
            ),
            tree = tree,
            selfId = 1
        )
        val nodes = PeopleDirectory.departments(tree, people)
        assertEquals(listOf("Головной офис", "Филиал", PeopleDirectory.UNASSIGNED_NAME), nodes.map { it.name })
        val head = nodes[0]
        assertEquals(4, head.total)
        assertEquals(2, head.online)
        assertEquals(listOf("Директор"), head.people.map { it.fullName })
        assertEquals(listOf(2, 1), head.children.map { it.total })
        assertEquals(0, nodes[1].total)
        assertEquals(listOf(6L), nodes[2].people.map { it.id })
    }

    @Test
    fun filteringKeepsMatchingBranchesAndShowsAWholeDepartmentWhoseNameMatches() {
        val people = PeopleDirectory.people(
            users = listOf(
                user(2, "Бух Один", departmentId = 2),
                user(3, "Бух Два", departmentId = 2, status = UserStatus.ONLINE),
                user(4, "Айти Один", departmentId = 3)
            ),
            tree = tree,
            selfId = 1
        )
        val nodes = PeopleDirectory.departments(tree, people)

        val byName = PeopleDirectory.filter(nodes, query = "айти", onlineOnly = false)
        assertEquals(listOf("Головной офис"), byName.map { it.name })
        assertEquals(listOf("ИТ"), byName[0].children.map { it.name })

        val byDepartment = PeopleDirectory.filter(nodes, query = "бухгал", onlineOnly = false)
        assertEquals(listOf("Бух Два", "Бух Один"), byDepartment[0].children[0].people.map { it.fullName }.sorted())

        val online = PeopleDirectory.filter(nodes, query = "", onlineOnly = true)
        assertEquals(listOf("Бух Два"), online[0].children[0].people.map { it.fullName })
        assertEquals(1, online[0].children.size)
    }

    @Test
    fun sectionsAreCyrillicFirstThenLatinThenOther() {
        val people = PeopleDirectory.people(
            users = listOf(
                user(2, "Яковлев Ян"), user(3, "Ёлкин Пётр"), user(4, "Smith John"),
                user(5, "Алексеев Иван"), user(6, "123 Бот"), user(7, "Еремеев Олег")
            ),
            tree = null,
            selfId = 1
        )
        val sections = PeopleDirectory.sections(people)
        assertEquals(listOf("А", "Е", "Я", "S", "#"), sections.map { it.letter })
        // «Ё» сортируется как «Е».
        assertEquals(listOf("Ёлкин Пётр", "Еремеев Олег"), sections[1].people.map { it.fullName })
    }
}
