package com.openmychat.mobile.build

import com.openmychat.mobile.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseConfigurationTest {

    @Test
    fun debugVariantIsExplicitlyIdentifiable() {
        assertEquals("debug", BuildConfig.BUILD_TYPE)
        assertTrue(BuildConfig.DEBUG)
    }
}
