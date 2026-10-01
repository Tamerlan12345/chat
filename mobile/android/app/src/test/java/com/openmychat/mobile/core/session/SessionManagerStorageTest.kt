package com.openmychat.mobile.core.session

import android.content.SharedPreferences
import com.openmychat.mobile.data.model.User
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class SessionManagerStorageTest {

    @Test
    fun sessionManagerNeverFallsBackToPlaintextSessionStorage() {
        val source = File(projectRoot(), "app/src/main/java/com/openmychat/mobile/core/session/SessionManager.kt")
            .readText()

        assertFalse(
            "session credentials must not be saved through ordinary SharedPreferences",
            source.contains("getSharedPreferences(\"centychat_fallback_session\"")
        )
        assertTrue(
            "callers need an observable storage-unavailable state",
            source.contains("SessionStorageState")
        )
    }

    @Test
    fun unavailableSecureStorageClearsCredentialsAndDoesNotPersistThem() {
        val storageConstructor = SessionManager::class.java.declaredConstructors
            .singleOrNull { constructor ->
                constructor.parameterTypes.size == 2 &&
                    constructor.parameterTypes[0] == SharedPreferences::class.java &&
                    constructor.parameterTypes[1] == Boolean::class.javaPrimitiveType
            }
            ?: throw AssertionError("SessionManager must provide an internal storage constructor for deterministic tests")
        storageConstructor.isAccessible = true
        val storage = FailingSharedPreferences()
        val manager = storageConstructor.newInstance(storage, false) as SessionManager

        try {
            manager.saveAuthSuccess(
                user = User(id = 1, username = "alice", fullName = "Alice"),
                token = "sensitive-token"
            )
            fail("authentication must fail when secure storage cannot persist the session")
        } catch (_: SecureStorageUnavailableException) {
            // Expected: callers receive a recoverable storage error.
        }
        manager.deviceSecret = "sensitive-device-secret"

        assertEquals(SessionStorageState.UNAVAILABLE, manager.storageState.value)
        assertNull(manager.token)
        assertNull(manager.currentUser)
        assertNull(manager.deviceSecret)
        assertTrue(storage.persistedValues.isEmpty())
    }

    @Test
    fun backupRulesExcludeEveryActualSessionStoreFromCloudAndDeviceTransfer() {
        val projectRoot = projectRoot()
        val backupRules = File(projectRoot, "app/src/main/res/xml/backup_rules.xml").readText()
        val extractionRules = File(projectRoot, "app/src/main/res/xml/data_extraction_rules.xml").readText()

        listOf("centychat_secure_session.xml", "centychat_fallback_session.xml").forEach { store ->
            assertTrue("full backup must exclude $store", backupRules.contains("path=\"$store\""))
            assertTrue("cloud backup must exclude $store", extractionRules.substringAfter("<cloud-backup>").substringBefore("</cloud-backup>").contains("path=\"$store\""))
            assertTrue("device transfer must exclude $store", extractionRules.substringAfter("<device-transfer>").substringBefore("</device-transfer>").contains("path=\"$store\""))
        }
    }

    private fun projectRoot(): File {
        val workingDirectory = requireNotNull(System.getProperty("user.dir"))
        return generateSequence(File(workingDirectory)) { it.parentFile }
            .first { File(it, "app/src/main/res/xml/backup_rules.xml").isFile }
    }

    private class FailingSharedPreferences : SharedPreferences {
        val persistedValues = mutableMapOf<String, Any?>()

        override fun getAll(): MutableMap<String, *> = persistedValues
        override fun getString(key: String, defValue: String?): String? = defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? = defValues
        override fun getInt(key: String, defValue: Int): Int = defValue
        override fun getLong(key: String, defValue: Long): Long = defValue
        override fun getFloat(key: String, defValue: Float): Float = defValue
        override fun getBoolean(key: String, defValue: Boolean): Boolean = defValue
        override fun contains(key: String): Boolean = false
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit

        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            override fun putString(key: String, value: String?): SharedPreferences.Editor = this
            override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = this
            override fun putInt(key: String, value: Int): SharedPreferences.Editor = this
            override fun putLong(key: String, value: Long): SharedPreferences.Editor = this
            override fun putFloat(key: String, value: Float): SharedPreferences.Editor = this
            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = this
            override fun remove(key: String): SharedPreferences.Editor = this
            override fun clear(): SharedPreferences.Editor = this
            override fun commit(): Boolean = false
            override fun apply() {
                throw IllegalStateException("secure storage unavailable")
            }
        }
    }
}
