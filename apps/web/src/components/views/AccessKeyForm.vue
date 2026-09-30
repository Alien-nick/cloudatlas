<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AddCredentialsResponse } from '@cloudatlas/shared'
import { api, ApiError } from '@/lib/api'

/**
 * Access keys, for a machine with no AWS profile.
 *
 * The keys go to the local server once. It checks them with AWS, then saves
 * them as a profile in ~/.aws/credentials — where `aws configure` would — and
 * answers with the profile name only. The fields are cleared as soon as the
 * request is sent, so the secret does not linger in the page either.
 */

const props = defineProps<{ regions: string[] }>()
const emit = defineEmits<{ saved: [result: AddCredentialsResponse] }>()

const accessKeyId = ref('')
const secretAccessKey = ref('')
const sessionToken = ref('')
const region = ref(props.regions[0] ?? 'us-east-1')
const profile = ref('cloudatlas')

const saving = ref(false)
const error = ref<string | null>(null)

const temporary = computed(() => accessKeyId.value.trim().startsWith('ASIA'))
const canSubmit = computed(
  () =>
    !saving.value &&
    accessKeyId.value.trim().length > 0 &&
    secretAccessKey.value.trim().length > 0 &&
    (!temporary.value || sessionToken.value.trim().length > 0) &&
    profile.value.trim().length > 0,
)

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  saving.value = true
  error.value = null
  const body = {
    accessKeyId: accessKeyId.value.trim(),
    secretAccessKey: secretAccessKey.value.trim(),
    ...(sessionToken.value.trim() ? { sessionToken: sessionToken.value.trim() } : {}),
    region: region.value,
    profile: profile.value.trim(),
  }
  // Out of the page as soon as they are in flight; on failure the user
  // re-enters the secret rather than it sitting in a field.
  secretAccessKey.value = ''
  sessionToken.value = ''
  try {
    const result = await api.addCredentials(body)
    accessKeyId.value = ''
    emit('saved', result)
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

const inputClass =
  'h-[32px] w-full rounded-[7px] border border-border2 bg-panel2 px-[10px] font-mono text-[12px] text-text outline-none placeholder:text-faint focus:border-text'
</script>

<template>
  <form class="flex flex-col gap-[10px]" autocomplete="off" @submit.prevent="submit">
    <p class="text-[12px] leading-[1.55] text-muted">
      No AWS profile was found on this machine. Enter access keys and CloudAtlas will check them
      with AWS, then save them as a profile in
      <span class="font-mono text-[11.5px] text-text">~/.aws/credentials</span> — the same place
      <span class="font-mono text-[11.5px] text-text">aws configure</span> would.
    </p>

    <label class="flex flex-col gap-[5px]">
      <span class="text-[11px] font-semibold text-muted">Access key ID</span>
      <input
        v-model="accessKeyId"
        :class="inputClass"
        placeholder="AKIA…"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="characters"
      />
    </label>

    <label class="flex flex-col gap-[5px]">
      <span class="text-[11px] font-semibold text-muted">Secret access key</span>
      <input
        v-model="secretAccessKey"
        :class="inputClass"
        type="password"
        spellcheck="false"
        autocomplete="off"
      />
    </label>

    <label class="flex flex-col gap-[5px]">
      <span class="text-[11px] font-semibold text-muted">
        Session token
        <span class="font-normal text-faint">{{ temporary ? '— required for temporary (ASIA…) keys' : '— only for temporary keys' }}</span>
      </span>
      <input
        v-model="sessionToken"
        :class="inputClass"
        type="password"
        spellcheck="false"
        autocomplete="off"
      />
    </label>

    <div class="flex gap-[10px]">
      <label class="flex flex-1 flex-col gap-[5px]">
        <span class="text-[11px] font-semibold text-muted">Default region</span>
        <select v-model="region" :class="inputClass">
          <option v-for="option in regions" :key="option" :value="option">{{ option }}</option>
        </select>
      </label>
      <label class="flex flex-1 flex-col gap-[5px]">
        <span class="text-[11px] font-semibold text-muted">Save as profile</span>
        <input v-model="profile" :class="inputClass" spellcheck="false" autocomplete="off" />
      </label>
    </div>

    <p class="rounded-[7px] border border-border bg-panel2 px-[10px] py-[8px] text-[11px] leading-[1.55] text-muted">
      Use keys for an IAM user with read-only access — CloudAtlas never needs more.
      <span class="font-mono text-text">docs/iam-policy.json</span> lists every action it calls.
      The keys are verified with <span class="font-mono text-text">sts:GetCallerIdentity</span>
      before anything is saved, and are never sent back to this page. To remove them later, delete
      the profile's section from <span class="font-mono text-text">~/.aws/credentials</span>.
    </p>

    <p v-if="error" class="text-[11.5px] leading-[1.5] text-bad">{{ error }}</p>

    <button
      type="submit"
      class="h-[34px] cursor-pointer rounded-[7px] border border-border2 bg-raise text-[12.5px] font-medium text-text hover:border-text disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="!canSubmit"
    >
      {{ saving ? 'Checking with AWS…' : 'Verify and save' }}
    </button>
  </form>
</template>
