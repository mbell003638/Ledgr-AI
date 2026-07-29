import re

def refactor_to_concept(filepath, is_advanced=False):
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Replace AccordionRow definition
    new_accordion_row = '''const AccordionRow = ({ title, subtitle, isLast, expandedKey, setExpandedKey, children, theme }: any) => {
  const isExpanded = expandedKey === title;
  return (
    <View style={{ borderBottomWidth: isLast && !isExpanded ? 0 : 1, borderBottomColor: theme.color.border, backgroundColor: isExpanded ? theme.color.brandPrimary + "0D" : "transparent" }}>
      <Pressable onPress={() => setExpandedKey(isExpanded ? null : title)} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12 }}>
        <View style={{ flex: 1, paddingRight: 16 }}>
          <Text style={{ fontSize: 15, fontWeight: "500", color: theme.color.onSurface }}>{title}</Text>
          {subtitle && <Text style={{ fontSize: 12, color: theme.color.muted, marginTop: 4 }}>{subtitle}</Text>}
        </View>
        <Ionicons name={isExpanded ? "chevron-down" : "chevron-forward"} size={20} color={theme.color.muted} />
      </Pressable>
      {isExpanded && <View style={{ paddingVertical: 16, paddingTop: 4, backgroundColor: "transparent" }}>{children}</View>}
    </View>
  );
};'''

    content = re.sub(r'const AccordionRow = \(\{.*?\n\};\n', new_accordion_row + '\n', content, flags=re.DOTALL)

    # 2. SimpleRow definition update
    # The original SimpleRow doesn't exist in settings.tsx, only advanced-settings.tsx might have it or not, let's just make sure it's injected if it's there.
    if is_advanced:
        new_simple_row = '''const SimpleRow = ({ title, subtitle, onPress, isLast, theme, rightElement }: any) => (
  <Pressable onPress={onPress} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: isLast ? 0 : 1, borderBottomColor: theme.color.border }}>
    <View style={{ flex: 1, paddingRight: 16 }}>
      <Text style={[{ fontSize: 15, fontWeight: "500", color: theme.color.onSurface }, rightElement?.titleStyle]}>{title}</Text>
      {subtitle && <Text style={[{ fontSize: 12, color: theme.color.muted, marginTop: 4 }, rightElement?.subtitleStyle]}>{subtitle}</Text>}
    </View>
    {rightElement?.custom || <Ionicons name="chevron-forward" size={20} color={rightElement?.chevronColor || theme.color.muted} />}
  </Pressable>
);'''
        if "const SimpleRow =" in content:
            content = re.sub(r'const SimpleRow = \(\{.*?\n\);\n', new_simple_row + '\n', content, flags=re.DOTALL)
        else:
            content = content.replace("export default function", new_simple_row + "\n\nexport default function")

    # 3. Replace card containers
    # The original has: <SectionTitle title="Something" theme={theme} />\n<View style={{ backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.lg, overflow: "hidden", borderWidth: 1, borderColor: theme.color.border }}>
    def replacer(match):
        title = match.group(1)
        hint = ""
        if title == "Account":
            title = "Business Profile"
            hint = "Manage your basic company info and defaults."
        elif title == "Security & Data":
            hint = "Protect your sensitive actions and backups."
        elif title == "Business Accounts (Books)":
            hint = "Manage multi-tenant ledgers."
        elif title == "Accounting & Workflow":
            hint = "Configure your accounting methods."
        elif title == "AI & Integrations":
            hint = "Configure your Gemini API access."
            
        return f'''<View style={{{{ backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginTop: theme.spacing.lg, padding: 20 }}}}>
              <Text style={{{{ fontSize: 16, fontWeight: "600", color: theme.color.brandPrimary, marginBottom: 8 }}}}>{title}</Text>
              {f'<Text style={{{{ fontSize: 13, color: theme.color.muted, marginBottom: 16, lineHeight: 18 }}}}>{hint}</Text>' if hint else ''}'''
              
    content = re.sub(r'<SectionTitle title="([^"]+)" theme=\{theme\} />\s*<View style=\{\{ backgroundColor: theme\.color\.surfaceSecondary, borderRadius: theme\.radius\.lg, overflow: "hidden", borderWidth: 1, borderColor: theme\.color\.border \}\}>', replacer, content)

    # 4. Remove all icon="X" and iconColor={...} and title="Business Profile" in AccordionRow where they don't belong
    content = re.sub(r'icon="[^"]+"\s*', '', content)
    content = re.sub(r'iconColor=\{[^}]+\}\s*', '', content)
    
    # 5. Fix "Business Profile" accordion row which should just be "Company Info & Logo"
    content = content.replace('title="Business Profile"', 'title="Company Info & Logo"')
    
    # 6. Advanced settings button styling in settings.tsx
    if not is_advanced:
        adv_btn_old = r'<Pressable onPress=\{\(\) => router\.push\("/advanced-settings"\)\} style=\{\{ marginTop: theme\.spacing\.xl, borderRadius: theme\.radius\.lg, borderWidth: 1, borderColor: theme\.color\.brandPrimary \+ "40", backgroundColor: theme\.color\.brandPrimary \+ "15", overflow: "hidden" \}\}>\s*<View style=\{\{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 16, paddingHorizontal: 20 \}\}>\s*<View style=\{\{ flexDirection: "row", alignItems: "center", flex: 1 \}\}>\s*<View style=\{\{ width: 32, height: 32, borderRadius: 10, backgroundColor: theme\.color\.brandPrimary \+ "25", alignItems: "center", justifyContent: "center", marginRight: 14 \}\}>\s*<Ionicons name="settings" size=\{18\} color=\{theme\.color\.brandPrimary\} />\s*</View>\s*<View style=\{\{ flex: 1, paddingRight: 16 \}\}>\s*<Text style=\{\{ fontSize: 16, fontWeight: "600", color: theme\.color\.brandPrimary \}\}>Advanced Settings</Text>\s*<Text style=\{\{ fontSize: 13, color: theme\.color\.brandPrimary \+ "aa", marginTop: 4 \}\}>AI, Multi-tenant, Backups\.\.\.</Text>\s*</View>\s*</View>\s*<Ionicons name="chevron-forward" size=\{20\} color=\{theme\.color\.brandPrimary\} />\s*</View>\s*</Pressable>'
        
        adv_btn_new = '''<Pressable onPress={() => router.push("/advanced-settings")} style={{ marginTop: theme.spacing.lg, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.brandPrimary, backgroundColor: theme.color.surfaceSecondary, padding: 20, paddingBottom: 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 20 }}>
                <View style={{ flex: 1, paddingRight: 16 }}>
                  <Text style={{ fontSize: 15, fontWeight: "500", color: theme.color.brandPrimary }}>Advanced Settings</Text>
                  <Text style={{ fontSize: 12, color: theme.color.muted, marginTop: 4 }}>AI config, Workflows, Opening Balances, Backup...</Text>
                </View>
                <View style={{ backgroundColor: theme.color.brandPrimary + "25", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 }}>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: theme.color.brandPrimary }}>Open ›</Text>
                </View>
              </View>
            </Pressable>'''
        content = re.sub(adv_btn_old, adv_btn_new, content)

    # 7. Add Danger Zone title back inside advanced-settings.tsx if not caught by SectionTitle logic
    if is_advanced:
        content = content.replace('title="Danger Zone"', 'title="Danger Zone"\n                subtitle="Reset all ledgers"')
        # Since danger zone doesn't have a section title in advanced-settings? 
        # Wait, advanced-settings.tsx has <SectionTitle title="Security & Data" />. So it will be caught.
        
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

refactor_to_concept("frontend/app/(tabs)/settings.tsx", False)
refactor_to_concept("frontend/app/advanced-settings.tsx", True)
