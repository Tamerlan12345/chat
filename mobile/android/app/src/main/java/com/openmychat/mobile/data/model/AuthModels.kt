package com.openmychat.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class KnockRequest(
    @SerialName("device_id")
    val deviceId: String,

    @SerialName("device_secret")
    val deviceSecret: String? = null,

    @SerialName("device_name")
    val deviceName: String? = null,

    @SerialName("platform")
    val platform: String = "Android",

    @SerialName("client_version")
    val clientVersion: String = "1.0.0"
)

@Serializable
data class KnockResponse(
    @SerialName("status")
    val status: String, // paired, login_required, pending, too_many_pending

    @SerialName("message")
    val message: String? = null,

    @SerialName("device_id")
    val deviceId: String? = null,

    @SerialName("device_name")
    val deviceName: String? = null,

    @SerialName("ip_address")
    val ipAddress: String? = null,

    @SerialName("auto_matched")
    val autoMatched: Boolean = false,

    @SerialName("user")
    val user: User? = null,

    @SerialName("token")
    val token: String? = null
)

@Serializable
data class DeviceClaimRequest(
    @SerialName("device_id")
    val deviceId: String,

    @SerialName("device_secret")
    val deviceSecret: String
)

@Serializable
data class DeviceClaimResponse(
    @SerialName("claimed")
    val claimed: Boolean,

    @SerialName("error")
    val error: String? = null
)

@Serializable
data class DeviceUnbindRequest(
    @SerialName("device_id")
    val deviceId: String? = null
)

@Serializable
data class LoginRequest(
    @SerialName("username")
    val username: String,

    @SerialName("password")
    val password: String
)

@Serializable
data class AuthSuccessResponse(
    @SerialName("user")
    val user: User,

    @SerialName("token")
    val token: String
)

@Serializable
data class ChangePasswordRequest(
    @SerialName("oldPassword")
    val oldPassword: String,

    @SerialName("newPassword")
    val newPassword: String
)

@Serializable
data class ChangePasswordResponse(
    @SerialName("success")
    val success: Boolean = true,

    @SerialName("message")
    val message: String = "",

    @SerialName("token")
    val token: String? = null,

    @SerialName("user")
    val user: User? = null
)

@Serializable
data class UpdateProfileRequest(
    @SerialName("full_name")
    val fullName: String? = null,

    @SerialName("email")
    val email: String? = null,

    @SerialName("phone")
    val phone: String? = null,

    @SerialName("custom_status")
    val customStatus: String? = null,

    @SerialName("avatar_url")
    val avatarUrl: String? = null
)

/** `GET /api/auth/me` wraps the profile: `{ user }`. */
@Serializable
data class MeResponse(
    @SerialName("user")
    val user: User
)

/** `POST /api/auth/refresh` returns only the replacement token: `{ token }`. */
@Serializable
data class RefreshResponse(
    @SerialName("token")
    val token: String
)

/** `POST /api/auth/logout`: `{ success }`. */
@Serializable
data class LogoutResponse(
    @SerialName("success")
    val success: Boolean = true
)

/** Body of every non-2xx JSON response: `{ error, code? }`. */
@Serializable
data class ApiErrorBody(
    @SerialName("error")
    val error: String,

    @SerialName("code")
    val code: String? = null
)
