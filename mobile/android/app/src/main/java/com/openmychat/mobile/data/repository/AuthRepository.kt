package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.MustChangePasswordException
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.ChangePasswordRequest
import com.openmychat.mobile.data.model.ChangePasswordResponse
import com.openmychat.mobile.data.model.DeviceClaimRequest
import com.openmychat.mobile.data.model.HealthStatus
import com.openmychat.mobile.data.model.KnockRequest
import com.openmychat.mobile.data.model.LoginRequest
import kotlinx.coroutines.flow.StateFlow
import java.security.SecureRandom
import javax.inject.Inject
import javax.inject.Singleton

sealed interface ServerConnectResult {
    val health: HealthStatus
    val knockStatus: String?

    /** The device was already paired; an authenticated session has been stored. */
    data class Paired(override val health: HealthStatus, override val knockStatus: String?) : ServerConnectResult

    /** The server is reachable and stored, but the user still has to sign in. */
    data class LoginRequired(override val health: HealthStatus, override val knockStatus: String?) : ServerConnectResult
}

enum class LoginResult { SUCCESS, MUST_CHANGE_PASSWORD }

interface AuthRepository {
    val serverUrl: String
    val mustChangePassword: StateFlow<Boolean>
    val isPasswordChangeForced: Boolean
    val hasSessionToken: Boolean

    /** Verifies and stores the endpoint; restores the previous endpoint and rethrows on failure. */
    suspend fun connect(rawUrl: String): ServerConnectResult

    /** Signs in and claims the device. Secure storage failures are rethrown, never swallowed. */
    suspend fun login(username: String, password: String): LoginResult

    suspend fun changePassword(oldPassword: String, newPassword: String): ChangePasswordResponse

    /** Clears the local session (remote logout is best effort). Throws when it cannot be cleared. */
    suspend fun logout()
}

@Singleton
class DefaultAuthRepository @Inject constructor(
    private val apiClient: ApiClient,
    private val sessionManager: SessionManager
) : AuthRepository {

    override val serverUrl: String get() = sessionManager.serverUrl
    override val mustChangePassword: StateFlow<Boolean> get() = sessionManager.mustChangePasswordFlow
    override val isPasswordChangeForced: Boolean get() = sessionManager.mustChangePassword
    override val hasSessionToken: Boolean get() = sessionManager.token != null

    override suspend fun connect(rawUrl: String): ServerConnectResult {
        try {
            val endpoint = sessionManager.validateServerEndpoint(rawUrl).getOrElse { throw it }
            val health = apiClient.checkHealthAt(endpoint)
            val knockResp = try {
                apiClient.knockAt(
                    endpoint,
                    KnockRequest(
                        deviceId = sessionManager.deviceId,
                        deviceSecret = null,
                        deviceName = "Android Device"
                    )
                )
            } catch (_: Exception) {
                null
            }

            sessionManager.commitVerifiedServerEndpoint(endpoint)

            return if (knockResp?.status == "paired" && knockResp.token != null && knockResp.user != null) {
                sessionManager.saveAuthSuccess(knockResp.user, knockResp.token)
                ServerConnectResult.Paired(health, knockResp.status)
            } else {
                ServerConnectResult.LoginRequired(health, knockResp?.status)
            }
        } catch (error: Exception) {
            sessionManager.restorePersistedServerEndpoint()
            throw error
        }
    }

    override suspend fun login(username: String, password: String): LoginResult {
        try {
            val resp = apiClient.login(LoginRequest(username = username.trim(), password = password))

            // Attempt device claim with a random 256-bit secret (base64url)
            try {
                val secretBytes = ByteArray(32)
                SecureRandom().nextBytes(secretBytes)
                val secretString = java.util.Base64.getUrlEncoder()
                    .withoutPadding()
                    .encodeToString(secretBytes)
                val claimResp = apiClient.claimDevice(
                    DeviceClaimRequest(
                        deviceId = sessionManager.deviceId,
                        deviceSecret = secretString
                    )
                )
                if (claimResp.claimed) {
                    sessionManager.deviceSecret = secretString
                }
            } catch (error: SecureStorageUnavailableException) {
                throw error
            } catch (_: Exception) {
                // Device claim is optional; password sign-in already succeeded.
            }

            return if (resp.user.mustChangePassword) {
                sessionManager.mustChangePassword = true
                LoginResult.MUST_CHANGE_PASSWORD
            } else {
                LoginResult.SUCCESS
            }
        } catch (_: MustChangePasswordException) {
            sessionManager.mustChangePassword = true
            return LoginResult.MUST_CHANGE_PASSWORD
        }
    }

    override suspend fun changePassword(oldPassword: String, newPassword: String): ChangePasswordResponse =
        apiClient.changePassword(ChangePasswordRequest(oldPassword = oldPassword, newPassword = newPassword))

    override suspend fun logout() {
        try {
            apiClient.logout()
        } catch (error: SecureStorageUnavailableException) {
            throw error
        } catch (_: Exception) {
            // The remote call failed after (or before) the local clear; make sure local state is gone.
            if (!sessionManager.clearSession()) throw SecureStorageUnavailableException()
        }
    }
}
