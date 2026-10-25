// FTMS — optional biometric login with an Android Keystore key (Phase 8).
//
// The key pair is created in the Android Keystore and can sign only right after a
// strong biometric check (BiometricPrompt with a CryptoObject). It is invalidated when
// the phone's enrolled fingerprints or faces change. The private key never leaves the
// Keystore and this code never sees biometric data: Android performs the check.
// The server registers the public key and verifies each signed challenge.
//
// This is a sign-in convenience only. Attendance never calls this plugin.

package eg.edu.asu.agr.ftms.devicekey

import android.app.Activity
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

private const val KEYSTORE = "AndroidKeyStore"
private const val KEY_ALIAS = "ftms-device-key-v1"
private const val PREFS = "ftms-device-key"
private const val PREF_CREDENTIAL_ID = "credentialId"
private val CREDENTIAL_ID = Regex("^[A-Za-z0-9_-]{16,128}$")

// Rejection codes, mapped to messages by the web app (apps/web/lib/native.ts).
private const val CANCELLED = "BIOMETRIC_CANCELLED"
private const val LOCKOUT = "BIOMETRIC_LOCKOUT"
private const val UNSUPPORTED = "BIOMETRIC_UNSUPPORTED"
private const val INVALIDATED = "BIOMETRIC_KEY_INVALIDATED"
private const val NOT_SET_UP = "BIOMETRIC_NOT_SET_UP"
private const val FAILED = "BIOMETRIC_FAILED"
private const val INVALID = "INVALID_ARGUMENT"

@InvokeArg
class SignArgs {
    lateinit var message: String
    var title: String = "Sign in"
    var subtitle: String? = null
    var cancel: String = "Cancel"
}

@InvokeArg
class CredentialArgs {
    lateinit var credentialId: String
}

@TauriPlugin
class DeviceKeyPlugin(private val activity: Activity) : Plugin(activity) {
    // Holds only the server's id for the key (not secret); the key itself is in the Keystore.
    private val prefs by lazy { activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun biometricState(): Int =
        BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG)

    private fun unavailableReason(state: Int): String? = when (state) {
        BiometricManager.BIOMETRIC_SUCCESS -> null
        BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "noHardware"
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "noneEnrolled"
        BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "unavailable"
        BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> "securityUpdate"
        else -> "unsupported"
    }

    private fun hasKey(): Boolean = try {
        keyStore().containsAlias(KEY_ALIAS)
    } catch (_: Exception) {
        false
    }

    private fun deleteAll() {
        try {
            val store = keyStore()
            if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS)
        } catch (_: Exception) {
            // Nothing to delete, or the Keystore is unavailable; the preference goes anyway.
        }
        prefs.edit().remove(PREF_CREDENTIAL_ID).apply()
    }

    /** `{ available, reason, enrolled, credentialId }` */
    @Command
    fun status(invoke: Invoke) {
        val state = biometricState()
        val credentialId = prefs.getString(PREF_CREDENTIAL_ID, null)
        val enrolled = credentialId != null && hasKey()
        val result = JSObject()
        result.put("available", state == BiometricManager.BIOMETRIC_SUCCESS)
        result.put("reason", unavailableReason(state) ?: JSONObject.NULL)
        result.put("enrolled", enrolled)
        result.put("credentialId", if (enrolled) credentialId else JSONObject.NULL)
        invoke.resolve(result)
    }

    /** A new key pair (any previous key and id are deleted). `{ publicKey }`: DER SPKI, base64. */
    @Command
    fun createKey(invoke: Invoke) {
        if (biometricState() != BiometricManager.BIOMETRIC_SUCCESS) {
            invoke.reject("Strong biometrics are not set up on this phone", UNSUPPORTED)
            return
        }
        deleteAll()
        try {
            val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // Every signature needs its own strong biometric check (no time window).
                spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            } else {
                @Suppress("DEPRECATION")
                spec.setUserAuthenticationValidityDurationSeconds(-1)
            }
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
            generator.initialize(spec.build())
            val pair = generator.generateKeyPair()
            val result = JSObject()
            result.put("publicKey", Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP))
            invoke.resolve(result)
        } catch (_: Exception) {
            deleteAll()
            invoke.reject("The key could not be created", FAILED)
        }
    }

    /** Shows the biometric prompt, then signs `message` (UTF-8). `{ signature }`: DER ECDSA, base64. */
    @Command
    fun sign(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(SignArgs::class.java)
        } catch (_: Exception) {
            invoke.reject("Invalid arguments", INVALID)
            return
        }
        val host = activity as? FragmentActivity
        if (host == null) {
            invoke.reject("The biometric prompt is not available", UNSUPPORTED)
            return
        }
        val signature: Signature
        try {
            val key = keyStore().getKey(KEY_ALIAS, null) as? PrivateKey
            if (key == null) {
                invoke.reject("Biometric login is not set up on this phone", NOT_SET_UP)
                return
            }
            signature = Signature.getInstance("SHA256withECDSA")
            signature.initSign(key)
        } catch (_: KeyPermanentlyInvalidatedException) {
            // New fingerprints or faces were enrolled: this key can never be used again.
            deleteAll()
            invoke.reject("The key was invalidated by a change of the phone's biometrics", INVALIDATED)
            return
        } catch (_: Exception) {
            invoke.reject("The key could not be used", FAILED)
            return
        }

        activity.runOnUiThread {
            val callback = object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    try {
                        val unlocked = result.cryptoObject?.signature
                            ?: throw IllegalStateException("no signature")
                        unlocked.update(args.message.toByteArray(Charsets.UTF_8))
                        val out = JSObject()
                        out.put("signature", Base64.encodeToString(unlocked.sign(), Base64.NO_WRAP))
                        invoke.resolve(out)
                    } catch (_: Exception) {
                        invoke.reject("Signing failed", FAILED)
                    }
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    val code = when (errorCode) {
                        BiometricPrompt.ERROR_USER_CANCELED,
                        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                        BiometricPrompt.ERROR_CANCELED,
                        BiometricPrompt.ERROR_TIMEOUT -> CANCELLED
                        BiometricPrompt.ERROR_LOCKOUT,
                        BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> LOCKOUT
                        BiometricPrompt.ERROR_NO_BIOMETRICS,
                        BiometricPrompt.ERROR_HW_NOT_PRESENT,
                        BiometricPrompt.ERROR_HW_UNAVAILABLE -> UNSUPPORTED
                        else -> FAILED
                    }
                    invoke.reject(errString.toString(), code)
                }

                // onAuthenticationFailed: one non-matching attempt; the prompt stays open.
            }
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(args.title)
                .apply { args.subtitle?.let { setSubtitle(it) } }
                .setNegativeButtonText(args.cancel)
                .setAllowedAuthenticators(BIOMETRIC_STRONG)
                .setConfirmationRequired(false)
                .build()
            BiometricPrompt(host, ContextCompat.getMainExecutor(activity), callback)
                .authenticate(info, BiometricPrompt.CryptoObject(signature))
        }
    }

    /** Remembers the server's id for this phone's key once registration succeeded. */
    @Command
    fun setCredential(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(CredentialArgs::class.java)
        } catch (_: Exception) {
            invoke.reject("Invalid arguments", INVALID)
            return
        }
        if (!CREDENTIAL_ID.matches(args.credentialId) || !hasKey()) {
            invoke.reject("No key to attach this credential to", INVALID)
            return
        }
        prefs.edit().putString(PREF_CREDENTIAL_ID, args.credentialId).apply()
        invoke.resolve()
    }

    /** Deletes the key and the credential id. The phone's own biometric settings are untouched. */
    @Command
    fun remove(invoke: Invoke) {
        deleteAll()
        invoke.resolve()
    }
}
