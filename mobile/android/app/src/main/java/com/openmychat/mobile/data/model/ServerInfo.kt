package com.openmychat.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ServerInfo(
    @SerialName("server_name")
    val serverName: String = "CentyChat Server",

    @SerialName("company_name")
    val companyName: String = "АО СК «Сентрас Иншуранс»",

    @SerialName("allow_registration")
    val allowRegistration: Boolean = false,

    @SerialName("message_edit_window_minutes")
    val messageEditWindowMinutes: String = "60",

    @SerialName("message_delete_window_minutes")
    val messageDeleteWindowMinutes: String = "60",

    @SerialName("version")
    val version: String = "1.0.0"
)

@Serializable
data class HealthStatus(
    @SerialName("status")
    val status: String = "ok",

    @SerialName("version")
    val version: String? = null,

    @SerialName("uptime")
    val uptime: Double? = null
)
