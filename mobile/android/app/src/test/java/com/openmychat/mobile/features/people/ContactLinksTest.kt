package com.openmychat.mobile.features.people

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ContactLinksTest {

    @Test
    fun phonesKeepOnlyDigitsAndTheLeadingPlus() {
        assertEquals("+77000000014", ContactLinks.phoneNumber("+7 (700) 000-00-14"))
        assertEquals("87012223344", ContactLinks.phoneNumber("8 701 222 33 44"))
    }

    @Test
    fun anythingThatIsNotAPhoneIsNotDialled() {
        assertNull(ContactLinks.phoneNumber("12"))
        assertNull(ContactLinks.phoneNumber("+7 701;ussd*#"))
        assertNull(ContactLinks.phoneNumber("позвоните секретарю"))
    }

    @Test
    fun emailsMustLookLikeAnAddressWithoutExtraParameters() {
        assertEquals("p.ivanov@example.test", ContactLinks.email(" p.ivanov@example.test "))
        assertNull(ContactLinks.email("a@b.example?subject=x&body=y"))
        assertNull(ContactLinks.email("не адрес"))
        assertNull(ContactLinks.email("a@b"))
    }
}
