retain_errors() {
  awk '
    BEGIN { last_migration = ""; diagnostic_count = 0 }
    {
      line = tolower($0)
      if (line ~ /applying migration/) {
        last_migration = $0
        next
      }
      if (line ~ /error|fail|fatal|unique|reset|migration|realtime/) {
        diagnostic_count++
        slot = ((diagnostic_count - 1) % 39) + 1
        diagnostics[slot] = $0
        if (diagnostic_count > 39) first_slot = (diagnostic_count % 39) + 1
      }
    }
    END {
      if (last_migration != "") print last_migration
      if (diagnostic_count < 39) {
        for (i = 1; i <= diagnostic_count; i++) print diagnostics[i]
      } else {
        for (i = 0; i < 39; i++) {
          slot = ((first_slot - 1 + i) % 39) + 1
          print diagnostics[slot]
        }
      }
    }
  '
}
