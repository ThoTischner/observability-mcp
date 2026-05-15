{{/* Common resource name. */}}
{{- define "observability-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully qualified app name. */}}
{{- define "observability-mcp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "observability-mcp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "observability-mcp.labels" -}}
helm.sh/chart: {{ include "observability-mcp.chart" . }}
{{ include "observability-mcp.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "observability-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "observability-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "observability-mcp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "observability-mcp.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "observability-mcp.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag -}}
{{- end -}}

{{/*
A plugin trust root is required whenever fail-closed verification is on
(verify.enabled) OR the runtime UI/upload install endpoints are enabled
(uiInstall.enabled — the server refuses to install unverified code).
*/}}
{{- define "observability-mcp.needsTrustRoot" -}}
{{- if or .Values.plugins.verify.enabled .Values.plugins.uiInstall.enabled -}}true{{- end -}}
{{- end -}}

{{/*
/app/plugins must be writable when connectors are installed at runtime
(uiInstall) or persisted across restarts (persistence) — otherwise the
init container only needs to seed a read-only emptyDir.
*/}}
{{- define "observability-mcp.pluginsWritable" -}}
{{- if or .Values.plugins.uiInstall.enabled .Values.plugins.persistence.enabled -}}true{{- end -}}
{{- end -}}

{{- define "observability-mcp.authSecretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-auth" (include "observability-mcp.fullname" .) -}}
{{- end -}}
{{- end -}}
