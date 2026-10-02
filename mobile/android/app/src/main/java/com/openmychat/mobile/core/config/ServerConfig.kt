package com.openmychat.mobile.core.config

import com.openmychat.mobile.BuildConfig
import com.openmychat.mobile.core.network.ServerEndpointPolicy
import com.openmychat.mobile.core.network.ValidatedEndpoint

/**
 * The one server this build talks to, fixed at build time.
 *
 * - Release: always [PRODUCTION_SERVER_URL]. The build configuration value is ignored here as a
 *   second line of defence, and nothing at runtime (UI, deep link, intent extra, stored value) can
 *   change it. Removing the editable server field removes the "type your corporate password into
 *   someone else's server" phishing vector.
 * - Debug: `BuildConfig.SERVER_URL` from the Gradle property `centychat.serverUrl` (default
 *   production), e.g. the local HTTPS dev stand `https://10.0.2.2:8443`. Still no runtime switch.
 */
object ServerConfig {
    const val PRODUCTION_SERVER_URL = "https://centychat-production.up.railway.app"

    val endpoint: ValidatedEndpoint by lazy {
        resolve(isDebugBuild = BuildConfig.DEBUG, configuredUrl = BuildConfig.SERVER_URL)
    }

    fun resolve(isDebugBuild: Boolean, configuredUrl: String): ValidatedEndpoint {
        val url = if (isDebugBuild) configuredUrl else PRODUCTION_SERVER_URL
        return ServerEndpointPolicy.validate(url, allowInsecureDebug = isDebugBuild).getOrElse { cause ->
            throw IllegalStateException("Invalid build-time server URL '$url'", cause)
        }
    }
}
