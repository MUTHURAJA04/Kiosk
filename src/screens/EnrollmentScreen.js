import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmployeeStorage } from '../services/employeeStorage';
import { useAdminSecurity } from '../context/AdminSecurityContext';

const FILTER_TABS = ['ALL', 'ENROLLED', 'PENDING'];

export default function EnrollmentScreen({ navigation }) {
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { resetInactivityTimer } = useAdminSecurity();

  const [employees, setEmployees] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('ALL');
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  /**
   * Loads employees from local storage & in-memory cache
   */
  const loadLocalEmployees = useCallback(async () => {
    setIsLoading(true);
    try {
      const list = await EmployeeStorage.getAllEmployees();
      setEmployees(list || []);
    } catch (err) {
      console.error('[EnrollmentScreen] Load employees error:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Pulls fresh updates from Supabase cloud
   */
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const updatedList = await EmployeeStorage.syncEmployeesFromCloud();
      setEmployees(updatedList || []);
    } catch (err) {
      console.warn('[EnrollmentScreen] Cloud sync error:', err);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // Reload local state whenever screen gains focus & reset inactivity timer
  useEffect(() => {
    if (isFocused) {
      resetInactivityTimer();
      loadLocalEmployees();
    }
  }, [isFocused, loadLocalEmployees, resetInactivityTimer]);

  // Subscribe to live employee directory changes (e.g. web deletions/updates)
  useEffect(() => {
    const unsubscribe = EmployeeStorage.addListener((updatedList) => {
      setEmployees(updatedList || []);
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // Search and Tab filtering
  const filteredEmployees = useMemo(() => {
    let list = employees;

    // Filter by Tab
    if (activeFilter === 'ENROLLED') {
      list = list.filter((e) => e.hasFace && e.template);
    } else if (activeFilter === 'PENDING') {
      list = list.filter((e) => !e.hasFace || !e.template);
    }

    // Filter by Query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (emp) =>
          (emp.full_name && emp.full_name.toLowerCase().includes(q)) ||
          (emp.name && emp.name.toLowerCase().includes(q)) ||
          (emp.employee_code && emp.employee_code.toLowerCase().includes(q)) ||
          (emp.employeeId && emp.employeeId.toLowerCase().includes(q)) ||
          (emp.department && emp.department.toLowerCase().includes(q)) ||
          (emp.role && emp.role.toLowerCase().includes(q))
      );
    }

    return list;
  }, [employees, activeFilter, searchQuery]);

  // Overall Statistics
  const stats = useMemo(() => {
    const total = employees.length;
    const enrolled = employees.filter((e) => e.hasFace && e.template).length;
    const pending = total - enrolled;
    return { total, enrolled, pending };
  }, [employees]);

  /**
   * Navigates to dedicated camera face registration
   */
  const handleNavigateToCapture = (emp) => {
    const isEnrolled = Boolean(emp.hasFace && emp.template);
    navigation.navigate('RegisterFace', {
      employee: emp,
      employeeId: emp.employee_code || emp.employeeId || emp.id,
      fullName: emp.full_name || emp.name || 'Employee',
      mode: isEnrolled ? 'update' : 'enroll',
    });
  };

  /**
   * Renders each employee card:
   * Left: Name + Details (tight spacing, full details without dots)
   * Right: Vertically centered Enroll / Update button
   */
  const renderEmployeeItem = ({ item }) => {
    const name = item.full_name || item.name || 'Unnamed Employee';
    const code = item.employee_code || item.employeeId || '';
    const dept = item.department || '';
    const role = item.role || '';
    const deptRole = [dept, role].filter(Boolean).join(' · ');
    const isEnrolled = Boolean(item.hasFace && item.template);

    return (
      <View style={styles.employeeCard}>
        {/* Left Side: Name + Full Details (No gap, no dots) */}
        <View style={styles.cardInfo}>
          <Text style={styles.nameText} numberOfLines={1} ellipsizeMode="tail">
            {name}
          </Text>

          <View style={styles.metaRow}>
            {Boolean(code && code !== 'ID-N/A') && (
              <Text style={styles.codeText}>
                {code}
              </Text>
            )}

            {Boolean(deptRole) && (
              <Text style={styles.deptRoleText}>
                {deptRole}
              </Text>
            )}
          </View>
        </View>

        {/* Right Side: Vertically Centered Action Button */}
        <TouchableOpacity
          style={[
            styles.actionButton,
            isEnrolled ? styles.actionButtonUpdate : styles.actionButtonEnroll,
          ]}
          onPress={() => handleNavigateToCapture(item)}
          activeOpacity={0.7}
        >
          <Text
            style={[
              styles.actionButtonText,
              isEnrolled ? styles.actionButtonTextUpdate : styles.actionButtonTextEnroll,
            ]}
          >
            {isEnrolled ? 'Update' : 'Enroll'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />

      {/* Top Stats Banner */}
      <View style={styles.statsBanner}>
        <View style={styles.statBox}>
          <Text style={styles.statNumber}>{stats.total}</Text>
          <Text style={styles.statLabel}>Total Staff</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statBox}>
          <Text style={[styles.statNumber, { color: '#10b981' }]}>{stats.enrolled}</Text>
          <Text style={styles.statLabel}>Enrolled</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statBox}>
          <Text style={[styles.statNumber, { color: '#f59e0b' }]}>{stats.pending}</Text>
          <Text style={styles.statLabel}>Pending</Text>
        </View>
      </View>

      {/* Search Bar (Full Width, No Sync Button) */}
      <View style={styles.searchSection}>
        <View style={styles.searchBar}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Search staff by name, code or role..."
            placeholderTextColor="#64748b"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCorrect={false}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.clearSearch}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Filter Tabs */}
      <View style={styles.filterTabs}>
        {FILTER_TABS.map((tab) => {
          const isActive = activeFilter === tab;
          let label = 'All';
          if (tab === 'ENROLLED') label = `Enrolled (${stats.enrolled})`;
          if (tab === 'PENDING') label = `Pending (${stats.pending})`;

          return (
            <TouchableOpacity
              key={tab}
              style={[styles.filterTab, isActive && styles.filterTabActive]}
              onPress={() => setActiveFilter(tab)}
              activeOpacity={0.7}
            >
              <Text style={[styles.filterTabText, isActive && styles.filterTabTextActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Employees List */}
      {isLoading && employees.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#38bdf8" />
          <Text style={styles.loadingText}>Loading staff directory...</Text>
        </View>
      ) : (
        <FlatList
          data={filteredEmployees}
          keyExtractor={(item) => String(item.id || item.employee_code || item.employeeId)}
          renderItem={renderEmployeeItem}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: Math.max(insets.bottom + 24, 32) },
          ]}
          initialNumToRender={15}
          maxToRenderPerBatch={20}
          windowSize={7}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              tintColor="#38bdf8"
              colors={['#38bdf8']}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>👥</Text>
              <Text style={styles.emptyTitle}>No Employees Found</Text>
              <Text style={styles.emptySubtitle}>
                {searchQuery
                  ? 'No staff members match your search criteria.'
                  : 'Pull down to refresh staff directory.'}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0f1d',
  },
  statsBanner: {
    flexDirection: 'row',
    backgroundColor: '#131d31',
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
  },
  statNumber: {
    fontSize: 20,
    fontWeight: '800',
    color: '#f8fafc',
  },
  statLabel: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '600',
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    backgroundColor: '#1e293b',
  },
  searchSection: {
    paddingHorizontal: 16,
    marginTop: 12,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#131d31',
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 42,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  searchIcon: {
    fontSize: 14,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 14,
    paddingVertical: 0,
  },
  clearSearch: {
    color: '#94a3b8',
    fontSize: 14,
    paddingHorizontal: 4,
  },
  filterTabs: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginTop: 10,
    marginBottom: 6,
  },
  filterTab: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: '#131d31',
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  filterTabActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8',
  },
  filterTabText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
  },
  filterTabTextActive: {
    color: '#ffffff',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 24,
  },

  /* Employee Card (Centered Button & Tight Details) */
  employeeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#131d31',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  cardInfo: {
    flex: 1,
    marginRight: 12,
    justifyContent: 'center',
  },
  nameText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: 2,
  },
  codeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94a3b8',
    marginRight: 12,
  },
  deptRoleText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#64748b',
  },
  actionButton: {
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: 6,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  actionButtonEnroll: {
    backgroundColor: '#0284c7',
  },
  actionButtonUpdate: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  actionButtonText: {
    fontSize: 12,
    fontWeight: '700',
  },
  actionButtonTextEnroll: {
    color: '#ffffff',
  },
  actionButtonTextUpdate: {
    color: '#38bdf8',
  },

  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#94a3b8',
    marginTop: 12,
    fontSize: 14,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
    maxWidth: 260,
  },
});
