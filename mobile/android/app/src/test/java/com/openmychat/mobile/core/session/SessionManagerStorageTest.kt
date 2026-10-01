package com.openmychat.mobile.core.session

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    private fun projectRoot(): File =
        generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "app/src/main/res/xml/backup_rules.xml").isFile }
}
