package expo.modules.ledgrnativeai

internal object NeedleJni {
  init {
    System.loadLibrary("needle_jni")
  }

  @JvmStatic external fun load(cact: ByteArray): Int
  @JvmStatic external fun init(systemPrompt: String, toolsJson: String): Int
  @JvmStatic external fun complete(input: String, maxTokens: Int): String
  @JvmStatic external fun reset()
}
