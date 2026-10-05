package com.openmychat.mobile.features.auth

/**
 * Client-side checks of the registration form, the same rules as iOS `RegistrationValidation`
 * (mirroring what the server shows: a password of at least 8 characters, logins of 3–64 characters
 * `[a-z0-9._-]`). The server stays the authority. Problems are codes; the screen words them.
 */
object RegistrationValidation {
    const val CODE_LENGTH = 6
    const val PASSWORD_MIN_LENGTH = 8
    private const val PASSWORD_MAX_BYTES = 1024
    private const val EMAIL_MAX_LENGTH = 254
    private const val NAME_MIN_LENGTH = 2
    private const val NAME_MAX_LENGTH = 100
    private val USERNAME_LENGTH = 3..64
    private val USERNAME_ALLOWED = ('a'..'z').toSet() + ('0'..'9').toSet() + setOf('.', '_', '-')

    enum class Field { EMAIL, DISPLAY_NAME, USERNAME, PASSWORD }

    enum class Problem {
        EMAIL_MISSING, EMAIL_INVALID,
        NAME_SHORT, NAME_LONG,
        USERNAME_LENGTH, USERNAME_CHARACTERS,
        PASSWORD_MISSING, PASSWORD_SHORT, PASSWORD_LONG
    }

    fun normalizedEmail(raw: String): String = raw.trim().lowercase()

    fun normalizedUsername(raw: String): String = raw.trim().lowercase()

    fun normalizedName(raw: String): String = raw.split(Regex("""\s+""")).filter { it.isNotEmpty() }.joinToString(" ")

    fun emailProblem(raw: String): Problem? {
        val email = normalizedEmail(raw)
        if (email.isEmpty()) return Problem.EMAIL_MISSING
        val parts = email.split("@")
        val domain = parts.lastOrNull().orEmpty()
        val valid = email.length <= EMAIL_MAX_LENGTH && parts.size == 2 && parts[0].isNotEmpty() &&
            email.none { it.isWhitespace() } && '.' in domain && !domain.startsWith(".") && !domain.endsWith(".")
        return if (valid) null else Problem.EMAIL_INVALID
    }

    fun nameProblem(raw: String): Problem? {
        val name = normalizedName(raw)
        val length = name.codePointCount(0, name.length)
        return when {
            length < NAME_MIN_LENGTH -> Problem.NAME_SHORT
            length > NAME_MAX_LENGTH -> Problem.NAME_LONG
            else -> null
        }
    }

    fun usernameProblem(raw: String): Problem? {
        val username = normalizedUsername(raw)
        return when {
            username.length !in USERNAME_LENGTH -> Problem.USERNAME_LENGTH
            username.any { it !in USERNAME_ALLOWED } -> Problem.USERNAME_CHARACTERS
            else -> null
        }
    }

    fun passwordProblem(password: String): Problem? = when {
        password.isEmpty() -> Problem.PASSWORD_MISSING
        password.codePointCount(0, password.length) < PASSWORD_MIN_LENGTH -> Problem.PASSWORD_SHORT
        password.toByteArray(Charsets.UTF_8).size > PASSWORD_MAX_BYTES -> Problem.PASSWORD_LONG
        else -> null
    }

    /** The first problem of every field that has one, in form order; empty when the form can be sent. */
    fun problems(email: String, displayName: String, username: String, password: String): Map<Field, Problem> = buildMap {
        emailProblem(email)?.let { put(Field.EMAIL, it) }
        nameProblem(displayName)?.let { put(Field.DISPLAY_NAME, it) }
        usernameProblem(username)?.let { put(Field.USERNAME, it) }
        passwordProblem(password)?.let { put(Field.PASSWORD, it) }
    }

    /** ASCII digits only, at most [CODE_LENGTH]. */
    fun sanitizedCode(raw: String): String = raw.filter { it in '0'..'9' }.take(CODE_LENGTH)
}
