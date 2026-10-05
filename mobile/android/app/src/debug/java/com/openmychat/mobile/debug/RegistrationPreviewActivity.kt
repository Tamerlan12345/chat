package com.openmychat.mobile.debug

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.openmychat.mobile.data.model.RegistrationChallenge
import com.openmychat.mobile.features.account.AccountFailure
import com.openmychat.mobile.features.auth.RegistrationActions
import com.openmychat.mobile.features.auth.RegistrationContent
import com.openmychat.mobile.features.auth.RegistrationState
import com.openmychat.mobile.ui.theme.CentyChatTheme

/**
 * DEBUG BUILDS ONLY: the registration steps the dev stand cannot reach (it has no SMTP, so
 * `/register/request` answers 503). Shows a fixed state from `--es step code|pending|wrong-code`,
 * for screenshots; nothing is sent anywhere.
 */
class RegistrationPreviewActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val now = System.currentTimeMillis()
        val code = RegistrationState(
            step = RegistrationState.Step.CODE,
            email = "ivan.ivanov@company.kz",
            displayName = "Иван Иванов",
            username = "ivanov",
            code = "1234",
            challenge = RegistrationChallenge("code_sent", "preview", 600),
            codeExpiresAt = now + 9 * 60_000 + 41_000,
            resendAvailableAt = now + 42_000
        )
        val state = when (intent.getStringExtra("step")) {
            "pending" -> RegistrationState(step = RegistrationState.Step.PENDING)
            "wrong-code" -> code.copy(code = "", failure = AccountFailure.WrongCode("Неверный код", attemptsLeft = 3))
            else -> code
        }
        setContent {
            CentyChatTheme {
                RegistrationContent(state = state, now = now, actions = object : RegistrationActions {})
            }
        }
    }
}
