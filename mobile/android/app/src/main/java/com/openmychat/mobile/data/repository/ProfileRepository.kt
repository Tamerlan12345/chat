package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.UpdateProfileRequest
import com.openmychat.mobile.data.model.User
import javax.inject.Inject
import javax.inject.Singleton

interface ProfileRepository {
    val cachedUser: User?
    suspend fun me(): User
    suspend fun updateCustomStatus(customStatus: String?): User

    /** Persists the user in secure storage; throws SecureStorageUnavailableException on failure. */
    fun storeUser(user: User)
}

@Singleton
class DefaultProfileRepository @Inject constructor(
    private val apiClient: ApiClient,
    private val sessionManager: SessionManager
) : ProfileRepository {
    override val cachedUser: User? get() = sessionManager.currentUser
    override suspend fun me(): User = apiClient.getMe()
    override suspend fun updateCustomStatus(customStatus: String?): User =
        apiClient.updateProfile(UpdateProfileRequest(customStatus = customStatus))

    override fun storeUser(user: User) {
        sessionManager.currentUser = user
    }
}
