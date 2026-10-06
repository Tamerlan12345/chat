package com.openmychat.mobile.features.notifications

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** QA D8: notifications are asked once, after sign-in, never on the sign-in screen. */
class NotificationPromptTest {

    @Test
    fun askedAfterSignInOnAndroid13AndLater() {
        assertTrue(NotificationPrompt.shouldExplain(sdk = 33, signedIn = true, granted = false, alreadyAsked = false))
    }

    @Test
    fun neverBeforeSignIn() {
        assertFalse(NotificationPrompt.shouldExplain(sdk = 36, signedIn = false, granted = false, alreadyAsked = false))
    }

    @Test
    fun onlyOnceAndOnlyWhileMissing() {
        assertFalse(NotificationPrompt.shouldExplain(sdk = 36, signedIn = true, granted = false, alreadyAsked = true))
        assertFalse(NotificationPrompt.shouldExplain(sdk = 36, signedIn = true, granted = true, alreadyAsked = false))
    }

    @Test
    fun olderAndroidHasNoRuntimePermission() {
        assertFalse(NotificationPrompt.shouldExplain(sdk = 32, signedIn = true, granted = false, alreadyAsked = false))
    }
}
