<script setup lang="ts">
import { DataTable, Select } from '@acme/ds-vue';
defineProps<{ rows: unknown[] }>();
</script>

<template>
  <div class="report">
    <DataTable class="dense" :rows="rows" />
    <DataTable class="dense" :rows="rows" />
    <DataTable class="dense" :rows="rows" />
    <DataTable class="dense" :rows="rows" />
    <DataTable class="dense" :rows="rows" />
    <DataTable :rows="rows" />
    <Select :options="[]" />
    <select><option>Q1</option></select>
    <select><option>Q2</option></select>
    <select><option>All</option></select>
    <select><option>EU</option></select>
  </div>
</template>

<style scoped>
.report { color: var(--ds-color-text); gap: var(--ds-space-2); }
</style>
