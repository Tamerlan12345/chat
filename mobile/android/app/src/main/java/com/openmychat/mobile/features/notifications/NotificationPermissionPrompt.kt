package com.openmychat.mobile.features.notifications

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.components.CentyPrimaryButton
import com.openmychat.mobile.ui.components.CentyTextButton
import com.openmychat.mobile.ui.theme.CentySpace
import com.openmychat.mobile.ui.theme.CentyTheme

/**
 * QA D8: the system «Allow notifications?» no longer meets the user on the sign-in screen, before
 * they know what the app is. It is asked once, after sign-in, behind one sentence saying why.
 */
object NotificationPrompt {
    /** Whether to show the explanation now. */
    fun shouldExplain(sdk: Int, signedIn: Boolean, granted: Boolean, alreadyAsked: Boolean): Boolean =
        sdk >= Build.VERSION_CODES.TIRAMISU && signedIn && !granted && !alreadyAsked
}

/** «Asked once» survives restarts; it is not a secret and not per account (the permission is the device's). */
internal class NotificationPromptStore(context: Context) {
    private val prefs = context.getSharedPreferences("centychat_ui", Context.MODE_PRIVATE)

    var asked: Boolean
        get() = prefs.getBoolean(KEY_ASKED, false)
        set(value) = prefs.edit { putBoolean(KEY_ASKED, value) }

    private companion object {
        const val KEY_ASKED = "notifications_explained"
    }
}

/** After sign-in: the explanation sheet, then (on «Разрешить») the system request. */
@Composable
fun NotificationPermissionPrompt(signedIn: Boolean) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val context = LocalContext.current
    val store = remember(context) { NotificationPromptStore(context.applicationContext) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    var explaining by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(signedIn) {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (NotificationPrompt.shouldExplain(Build.VERSION.SDK_INT, signedIn, granted, store.asked)) explaining = true
        if (!signedIn) explaining = false
    }
    if (!explaining) return
    val done = { allow: Boolean ->
        store.asked = true
        explaining = false
        if (allow) launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
    NotificationExplainer(onAllow = { done(true) }, onLater = { done(false) })
}

@Composable
private fun NotificationExplainer(onAllow: () -> Unit, onLater: () -> Unit) {
    val tokens = CentyTheme.tokens
    ModalBottomSheet(
        onDismissRequest = onLater,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = tokens.elevated,
        scrimColor = tokens.scrim
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = CentySpace.gutter)
                .padding(bottom = CentySpace.l)
                .testTag("notification-explainer"),
            verticalArrangement = Arrangement.spacedBy(CentySpace.m)
        ) {
            Icon(Icons.Outlined.NotificationsActive, contentDescription = null, tint = tokens.accentText, modifier = Modifier.size(32.dp))
            Text(
                stringResource(R.string.notifications_explain_title),
                style = MaterialTheme.typography.titleLarge,
                color = tokens.textStrong,
                modifier = Modifier.semantics { heading() }
            )
            Text(stringResource(R.string.notifications_explain_message), style = MaterialTheme.typography.bodyMedium, color = tokens.textSecondary)
            CentyPrimaryButton(
                text = stringResource(R.string.notifications_allow),
                onClick = onAllow,
                modifier = Modifier.fillMaxWidth().padding(top = CentySpace.s).testTag("notifications-allow")
            )
            CentyTextButton(onClick = onLater, modifier = Modifier.fillMaxWidth().testTag("notifications-later")) {
                Text(stringResource(R.string.notifications_later))
            }
        }
    }
}

