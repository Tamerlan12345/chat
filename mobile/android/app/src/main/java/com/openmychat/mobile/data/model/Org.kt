package com.openmychat.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * `GET /api/org/tree`: подразделения с вложенными отделами. Сотрудники в узлах дерева сервером
 * уже отфильтрованы (активные и одобренные), но берутся из `/api/users` — там одна запись на
 * человека, а живой статус приходит по WebSocket.
 */
@Serializable
data class OrgTree(
    @SerialName("tree")
    val tree: List<OrgDepartment> = emptyList(),

    @SerialName("totalUsers")
    val totalUsers: Int = 0,

    /** Сервер считает «в сети» и `online`, и `away`, как и настольный клиент. */
    @SerialName("onlineUsers")
    val onlineUsers: Int = 0
)

@Serializable
data class OrgDepartment(
    @SerialName("id")
    val id: Long,

    @SerialName("name")
    val name: String,

    @SerialName("parent_id")
    val parentId: Long? = null,

    @SerialName("dept_type")
    val type: String? = null,

    @SerialName("subDepartments")
    val subDepartments: List<OrgDepartment> = emptyList(),

    @SerialName("totalStaffCount")
    val totalStaffCount: Int = 0,

    @SerialName("onlineStaffCount")
    val onlineStaffCount: Int = 0
)
