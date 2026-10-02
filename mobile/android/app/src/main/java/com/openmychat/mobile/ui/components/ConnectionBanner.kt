package com.openmychat.mobile.ui.components

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.delay

/** What the banner says; null when everything is fine. */
enum class LinkProblem { OFFLINE, RECONNECTING, REFUSED, SIGNED_OUT }

/** Pure mapping, so the banner's decision can be tested without a device. */
fun linkProblem(state: ConnectionState, networkAvailable: Boolean): LinkProblem? = when {
    state is ConnectionState.Connected -> null
    !networkAvailable -> LinkProblem.OFFLINE
    state is ConnectionState.Retrying -> LinkProblem.REFUSED
    state is ConnectionState.Unauthorized -> LinkProblem.SIGNED_OUT
    else -> LinkProblem.RECONNECTING
}

/**
 * Compact banner under the top bar, only while the realtime link is down: warning while
 * reconnecting, danger when the device is offline or the session was refused. It slides down and
 * collapses when the link is back. A short grace period hides the normal connect on launch.
 */
@Composable
fun ConnectionBanner(
    state: ConnectionState,
    modifier: Modifier = Modifier,
    graceMillis: Long = 1_500,
    networkAvailable: Boolean = rememberNetworkAvailable()
) {
    val problem = linkProblem(state, networkAvailable)
    var shown by remember { mutableStateOf<LinkProblem?>(null) }
    LaunchedEffect(problem) {
        if (problem != null && shown == null) delay(graceMillis)
        shown = problem
    }
    val reduce = LocalReduceMotion.current
    var last by remember { mutableStateOf(LinkProblem.RECONNECTING) }
    shown?.let { last = it }
    val retryMessage = (state as? ConnectionState.Retrying)?.message

    AnimatedVisibility(
        visible = shown != null,
        modifier = modifier,
        enter = if (reduce) fadeIn(CentyMotion.fast()) else expandVertically(CentyMotion.slow(), expandFrom = Alignment.Top) + fadeIn(CentyMotion.slow()),
        exit = if (reduce) fadeOut(CentyMotion.fast()) else shrinkVertically(CentyMotion.base(), shrinkTowards = Alignment.Top) + fadeOut(CentyMotion.fast())
    ) {
        val tokens = CentyTheme.tokens
        val danger = last == LinkProblem.OFFLINE || last == LinkProblem.SIGNED_OUT
        val background by animateColorAsState(if (danger) tokens.dangerSoft else tokens.warningSoft, CentyMotion.base(), label = "banner-bg")
        val content by animateColorAsState(if (danger) tokens.dangerText else tokens.warningText, CentyMotion.base(), label = "banner-fg")
        val text = when (last) {
            LinkProblem.OFFLINE -> stringResource(R.string.connection_offline)
            LinkProblem.RECONNECTING -> stringResource(R.string.connection_reconnecting)
            LinkProblem.REFUSED -> retryMessage?.takeIf { it.isNotBlank() } ?: stringResource(R.string.connection_refused)
            LinkProblem.SIGNED_OUT -> stringResource(R.string.connection_signed_out)
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(background)
                .heightIn(min = 36.dp)
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .testTag("connection-banner")
                .semantics { liveRegion = LiveRegionMode.Polite },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Icon(
                imageVector = if (danger) Icons.Outlined.CloudOff else Icons.Outlined.Sync,
                contentDescription = null,
                tint = content,
                modifier = Modifier.size(16.dp)
            )
            Text(text, color = content, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
        }
    }
}

/** Whether the device has a validated internet connection; follows changes. */
@Composable
fun rememberNetworkAvailable(): Boolean {
    val context = LocalContext.current
    val manager = remember(context) { context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager }
    fun current(): Boolean = try {
        // No manager: assume online (the realtime state still drives the banner). No active
        // network: offline.
        if (manager == null) true
        else manager.getNetworkCapabilities(manager.activeNetwork)
            ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    } catch (_: Exception) {
        true
    }
    var available by remember(manager) { mutableStateOf(current()) }
    DisposableEffect(manager) {
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                available = true
            }

            // The default network is gone; a replacement arrives through onAvailable.
            override fun onLost(network: Network) {
                available = false
            }
        }
        try {
            manager?.registerDefaultNetworkCallback(callback)
        } catch (_: Exception) {
        }
        onDispose {
            try {
                manager?.unregisterNetworkCallback(callback)
            } catch (_: Exception) {
            }
        }
    }
    return available
}
