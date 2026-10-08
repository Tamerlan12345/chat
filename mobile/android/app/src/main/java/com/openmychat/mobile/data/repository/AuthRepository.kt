package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.MustChangePasswordException
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.ChangePasswordRequest
import com.openmychat.mobile.data.model.ChangePasswordResponse
import com.openmychat.mobile.data.model.DeviceClaimRequest
import com.openmychat.mobile.data.model.KnockRequest
import com.openmychat.mobile.data.model.LoginRequest
import kotlinx.coroutines.flow.StateFlow
import java.security.SecureRandom
import javax.inject.Inject
import javax.inject.Singleton

enum class LoginResult { SUCCESS, MUST_CHANGE_PASSWORD }

interface AuthRepository {
    val mustChangePassword: StateFlow<Boolean>
    val isPasswordChangeForced: Boolean
    val hasSessionToken: Boolean

    /**
     * Announces this device to the build-time server (`/auth/knock`), as the old server-setup step
     * did. Returns true only when the server answered "paired" and the session it issued was stored.
     * Without a device secret stored by an earlier claim nothing is sent: such a knock can never pair,
     * but the server would still record a pending device, notify admins and count a failed knock.
     */
    suspend fun knock(): Boolean

    /** Signs in and claims the device. Secure storage failures are rethrown, never swallowed. */
    suspend fun login(username: String, password: String): LoginResult

    suspend fun changePassword(oldPassword: String, newPassword: String): ChangePasswordResponse

    /** Clears the local session (remote logout is best effort). Throws when it cannot be cleared. */
    suspend fun logout()

    /**
     * Whether the server takes self-registrations (`allow_registration` of the public /settings/info,
     * decision Q); null when that could not be read.
     */
    suspend fun registrationOpen(): Boolean? = null

    /** False once the device's secure store refused a write (the session cannot be kept on it). */
    val secureStorageAvailable: Boolean get() = true
}

@Singleton
class DefaultAuthRepository @Inject constructor(
    private val apiClient: ApiClient,
    private val sessionManager: SessionManager,
    private val push: com.openmychat.mobile.data.push.PushTokenSource = NoPushTokens
) : AuthRepository {

    override val mustChangePassword: StateFlow<Boolean> get() = sessionManager.mustChangePasswordFlow
    override val isPasswordChangeForced: Boolean get() = sessionManager.mustChangePassword
    override val hasSessionToken: Boolean get() = sessionManager.token != null

    override suspend fun knock(): Boolean {
        val secret = sessionManager.deviceSecret?.takeIf { it.isNotBlank() } ?: return false
        val response = apiClient.knock(
            KnockRequest(
                deviceId = sessionManager.deviceId,
                deviceSecret = secret,
                deviceName = "Android Device"
            )
        )
        if (response.status != "paired" || response.token == null || response.user == null) return false
        sessionManager.saveAuthSuccess(response.user, response.token)
        return true
    }

    override suspend fun login(username: String, password: String): LoginResult {
        try {
            val resp = apiClient.login(LoginRequest(username = username.trim(), password = password))
            claimThisDevice(apiClient, sessionManager)

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

    override suspend fun registrationOpen(): Boolean? = try {
        apiClient.fetchServerInfo().allowRegistration
    } catch (error: kotlinx.coroutines.CancellationException) {
        throw error
    } catch (_: Exception) {
        null
    }

    override val secureStorageAvailable: Boolean
        get() = sessionManager.storageState.value == com.openmychat.mobile.core.session.SessionStorageState.AVAILABLE

    override suspend fun logout() {
        try {
            apiClient.logout()
        } catch (error: SecureStorageUnavailableException) {
            throw error
        } catch (_: Exception) {
            // The remote call failed after (or before) the local clear; make sure local state is gone.
            if (!sessionManager.clearSession()) throw SecureStorageUnavailableException()
        }
        // Signed out here: this device's push token goes too, even when the server was not reached.
        try {
            push.delete()
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (_: Exception) {
            // Best effort: /auth/logout (when it arrives) drops the token on the server as well.
        }
    }
}

/**
 * Claims this device for the account just signed in (password sign-in, or a registration that
 * signed in — parity P8): a random 256-bit secret (base64url) the login screen's knock uses later.
 * Optional — a failure leaves the sign-in as it is — except that a secure store that cannot keep the
 * secret is reported, never swallowed.
 */
internal suspend fun claimThisDevice(apiClient: ApiClient, sessionManager: SessionManager) {
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
    } catch (error: kotlinx.coroutines.CancellationException) {
        throw error
    } catch (_: Exception) {
        // Device claim is optional; the sign-in already succeeded.
    }
}

/** No push provider (tests, previews). */
object NoPushTokens : com.openmychat.mobile.data.push.PushTokenSource {
    override suspend fun currentToken(): String? = null
}
