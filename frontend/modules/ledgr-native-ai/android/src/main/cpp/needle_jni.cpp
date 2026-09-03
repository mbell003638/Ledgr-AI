#include <jni.h>
#include <string>
#include "needle.h"

extern "C" JNIEXPORT jint JNICALL
Java_expo_modules_ledgrnativeai_NeedleJni_load(JNIEnv* env, jclass, jbyteArray cact) {
  if (cact == nullptr) return -1;
  const jsize n = env->GetArrayLength(cact);
  jbyte* bytes = env->GetByteArrayElements(cact, nullptr);
  const int rc = needle_load(reinterpret_cast<const unsigned char*>(bytes), static_cast<unsigned long long>(n));
  env->ReleaseByteArrayElements(cact, bytes, JNI_ABORT);
  return rc;
}

extern "C" JNIEXPORT jint JNICALL
Java_expo_modules_ledgrnativeai_NeedleJni_init(JNIEnv* env, jclass, jstring systemPrompt, jstring toolsJson) {
  const char* prompt = systemPrompt ? env->GetStringUTFChars(systemPrompt, nullptr) : "";
  const char* tools = toolsJson ? env->GetStringUTFChars(toolsJson, nullptr) : "[]";
  const int rc = needle_init(prompt, tools, "");
  if (systemPrompt) env->ReleaseStringUTFChars(systemPrompt, prompt);
  if (toolsJson) env->ReleaseStringUTFChars(toolsJson, tools);
  return rc;
}

extern "C" JNIEXPORT jstring JNICALL
Java_expo_modules_ledgrnativeai_NeedleJni_complete(JNIEnv* env, jclass, jstring input, jint maxTokens) {
  const char* text = input ? env->GetStringUTFChars(input, nullptr) : "";
  char out[8192];
  out[0] = 0;
  needle_complete(text, maxTokens > 0 ? maxTokens : 128, out, sizeof(out));
  if (input) env->ReleaseStringUTFChars(input, text);
  return env->NewStringUTF(out);
}

extern "C" JNIEXPORT void JNICALL
Java_expo_modules_ledgrnativeai_NeedleJni_reset(JNIEnv*, jclass) {
  needle_reset();
}
