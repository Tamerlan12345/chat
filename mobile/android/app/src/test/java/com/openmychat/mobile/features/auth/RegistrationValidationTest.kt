package com.openmychat.mobile.features.auth

import com.openmychat.mobile.features.auth.RegistrationValidation.Problem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Same rules as iOS `RegistrationValidation`; the server stays the authority. */
class RegistrationValidationTest {

    @Test
    fun emailIsTrimmedLowercasedAndChecked() {
        assertEquals("ivan@company.example", RegistrationValidation.normalizedEmail("  Ivan@Company.EXAMPLE \n"))
        assertEquals(Problem.EMAIL_MISSING, RegistrationValidation.emailProblem("   "))
        listOf("ivan", "@company.example", "ivan@company", "ivan@.company.example", "ivan@company.example.", "iv an@company.example", "a@b@c.example")
            .forEach { assertEquals(it, Problem.EMAIL_INVALID, RegistrationValidation.emailProblem(it)) }
        assertEquals(Problem.EMAIL_INVALID, RegistrationValidation.emailProblem("a".repeat(250) + "@b.example"))
        assertNull(RegistrationValidation.emailProblem("ivan@company.example"))
    }

    @Test
    fun nameCollapsesWhitespaceAndNeedsTwoToAHundredCharacters() {
        assertEquals("Иван Иванов", RegistrationValidation.normalizedName("  Иван \n  Иванов "))
        assertEquals(Problem.NAME_SHORT, RegistrationValidation.nameProblem(" И "))
        assertEquals(Problem.NAME_LONG, RegistrationValidation.nameProblem("И".repeat(101)))
        assertNull(RegistrationValidation.nameProblem("Ив"))
        assertNull(RegistrationValidation.nameProblem("И".repeat(100)))
    }

    @Test
    fun usernameIsLatinDigitsDotDashUnderscoreOfThreeToSixtyFour() {
        assertEquals("ivanov", RegistrationValidation.normalizedUsername(" Ivanov "))
        assertEquals(Problem.USERNAME_LENGTH, RegistrationValidation.usernameProblem("iv"))
        assertEquals(Problem.USERNAME_LENGTH, RegistrationValidation.usernameProblem("i".repeat(65)))
        assertEquals(Problem.USERNAME_CHARACTERS, RegistrationValidation.usernameProblem("иванов"))
        assertEquals(Problem.USERNAME_CHARACTERS, RegistrationValidation.usernameProblem("ivan ov"))
        assertNull(RegistrationValidation.usernameProblem("Ivan.Ivanov_2-x"))
    }

    @Test
    fun passwordNeedsEightCharactersAndAtMost1024Bytes() {
        assertEquals(Problem.PASSWORD_MISSING, RegistrationValidation.passwordProblem(""))
        assertEquals(Problem.PASSWORD_SHORT, RegistrationValidation.passwordProblem("1234567"))
        assertNull(RegistrationValidation.passwordProblem("12345678"))
        // Cyrillic letters are two bytes each in UTF-8.
        assertEquals(Problem.PASSWORD_LONG, RegistrationValidation.passwordProblem("я".repeat(513)))
        assertNull(RegistrationValidation.passwordProblem("я".repeat(512)))
    }

    @Test
    fun theCodeKeepsOnlySixAsciiDigits() {
        assertEquals("123456", RegistrationValidation.sanitizedCode(" 12-34 56 78"))
        assertEquals("12", RegistrationValidation.sanitizedCode("1٣2")) // Arabic-Indic digits are not ASCII
    }

    @Test
    fun problemsAreListedPerFieldInFormOrder() {
        val problems = RegistrationValidation.problems(email = "", displayName = "Иван Иванов", username = "iv", password = "short")
        assertEquals(
            mapOf(
                RegistrationValidation.Field.EMAIL to Problem.EMAIL_MISSING,
                RegistrationValidation.Field.USERNAME to Problem.USERNAME_LENGTH,
                RegistrationValidation.Field.PASSWORD to Problem.PASSWORD_SHORT
            ),
            problems
        )
        assertEquals(
            emptyMap<RegistrationValidation.Field, Problem>(),
            RegistrationValidation.problems("ivan@company.example", "Иван Иванов", "ivanov", "Secret-12")
        )
    }
}
