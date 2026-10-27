import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  Modal,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import {
  getAllEmployees,
  createOrUpdateEmployeeBasicInfo,
  deleteEmployee,
} from '../database/db';
import { FaceMatcher } from '../services/faceMatcher';

export default function EnrollmentScreen({ navigation }) {
  const isFocused = useIsFocused();
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const isCompact = winWidth < 400;

  const [employees, setEmployees] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Add Employee Modal state
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [newFullName, setNewFullName] = useState('');
  const [newEmployeeId, setNewEmployeeId] = useState('');
  const [modalError, setModalError] = useState('');

  /**
   * Refreshes employee list from SQLite
   */
  const loadEmployees = useCallback(() => {
    setIsLoading(true);
    try {
      const list = getAllEmployees();
      setEmployees(list || []);
    } catch (err) {
      console.error('[EnrollmentScreen] Load employees error:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Reload whenever screen gains focus
  useEffect(() => {
    if (isFocused) {
      loadEmployees();
    }
  }, [isFocused, loadEmployees]);

  // Filtered employees by search query
  const filteredEmployees = useMemo(() => {
    if (!searchQuery.trim()) return employees;
    const q = searchQuery.toLowerCase().trim();
    return employees.filter(
      (emp) =>
        emp.name.toLowerCase().includes(q) ||
        emp.employeeId.toLowerCase().includes(q)
    );
  }, [employees, searchQuery]);

  // Stats computation
  const stats = useMemo(() => {
    const total = employees.length;
    const enrolled = employees.filter((e) => e.hasFace).length;
    const pending = total - enrolled;
    return { total, enrolled, pending };
  }, [employees]);

  /**
   * Handles deleting an employee record
   */
  const handleDeleteEmployee = (emp) => {
    Alert.alert(
      'Delete Employee?',
      `Are you sure you want to delete "${emp.name}" (${emp.employeeId}) and any associated biometric records?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteEmployee(emp.employeeId);
            FaceMatcher.loadEnrolledUsersSync();
            loadEmployees();
          },
        },
      ]
    );
  };

  /**
   * Validates modal fields and returns trimmed values or null
   */
  const validateModalInputs = () => {
    setModalError('');
    const name = newFullName.trim();
    const id = newEmployeeId.trim();

    if (!name) {
      setModalError('Please enter Full Name.');
      return null;
    }
    if (!id) {
      setModalError('Please enter Employee ID.');
      return null;
    }

    // Check unique employeeId
    const exists = employees.some(
      (e) => e.employeeId.toLowerCase() === id.toLowerCase()
    );
    if (exists) {
      setModalError(`Employee ID "${id}" is already registered.`);
      return null;
    }

    return { name, id };
  };

  /**
   * Saves profile in SQLite and closes modal
   */
  const handleSaveOnly = () => {
    const valid = validateModalInputs();
    if (!valid) return;

    createOrUpdateEmployeeBasicInfo(valid.id, valid.name);
    setIsModalVisible(false);
    setNewFullName('');
    setNewEmployeeId('');
    loadEmployees();
  };

  /**
   * Saves profile in SQLite and directly navigates to camera registration
   */
  const handleSaveAndRegister = () => {
    const valid = validateModalInputs();
    if (!valid) return;

    createOrUpdateEmployeeBasicInfo(valid.id, valid.name);
    setIsModalVisible(false);
    setNewFullName('');
    setNewEmployeeId('');
    loadEmployees();

    navigation.navigate('RegisterFace', {
      employeeId: valid.id,
      fullName: valid.name,
      mode: 'enroll',
    });
  };

  /**
   * Navigates to dedicated camera face registration
   */
  const handleNavigateToCapture = (emp, mode = 'enroll') => {
    navigation.navigate('RegisterFace', {
      employeeId: emp.employeeId,
      fullName: emp.name,
      mode,
    });
  };

  const renderInitials = (name) => {
    if (!name) return '??';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  };

  const renderEmployeeItem = ({ item }) => {
    return (
      <View style={styles.employeeCard}>
        {/* Avatar */}
        <View
          style={[
            styles.avatarBadge,
            { backgroundColor: item.hasFace ? '#0284c7' : '#475569' },
          ]}
        >
          <Text style={styles.avatarText}>{renderInitials(item.name)}</Text>
        </View>

        {/* Info Column */}
        <View style={styles.employeeInfoCol}>
          <Text style={styles.employeeName} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.employeeId} numberOfLines={1}>
            ID: {item.employeeId}
          </Text>

          {/* Biometric Status Tag */}
          <View style={styles.statusRow}>
            {item.hasFace ? (
              <View style={styles.enrolledBadge}>
                <Text style={styles.enrolledBadgeText}>
                  ✔ Enrolled {item.enrolledAt ? `• ${formatDate(item.enrolledAt)}` : ''}
                </Text>
              </View>
            ) : (
              <View style={styles.pendingBadge}>
                <Text style={styles.pendingBadgeText}>○ Pending Face Capture</Text>
              </View>
            )}
          </View>
        </View>

        {/* Action Buttons Column */}
        <View style={styles.actionsCol}>
          {item.hasFace ? (
            <TouchableOpacity
              style={styles.updateFaceButton}
              onPress={() => handleNavigateToCapture(item, 'update')}
              activeOpacity={0.7}
            >
              <Text style={styles.updateFaceButtonText}>Update Face</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.enrollFaceButton}
              onPress={() => handleNavigateToCapture(item, 'enroll')}
              activeOpacity={0.7}
            >
              <Text style={styles.enrollFaceButtonText}>Enroll Face</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.deleteIconButton}
            onPress={() => handleDeleteEmployee(item)}
            activeOpacity={0.6}
          >
            <Text style={styles.deleteIconText}>🗑</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Search Bar & Action Header */}
      <View style={styles.topHeaderContainer}>
        <View style={styles.topHeader}>
          <View style={styles.searchBarContainer}>
            <Text style={styles.searchIcon}>🔍</Text>
            <TextInput
              style={styles.searchInput}
              placeholder="Search by name or ID..."
              placeholderTextColor="#64748b"
              value={searchQuery}
              onChangeText={setSearchQuery}
              clearButtonMode="while-editing"
            />
          </View>

          <TouchableOpacity
            style={styles.addEmployeeButton}
            onPress={() => {
              setModalError('');
              setIsModalVisible(true);
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.addEmployeeButtonText}>
              {isCompact ? '+ Add' : '+ Add Employee'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Directory Stats Bar */}
      <View style={styles.statsBarContainer}>
        <View style={styles.statsBar}>
          <View style={styles.statChip}>
            <Text style={styles.statLabel}>Total:</Text>
            <Text style={styles.statValue}>{stats.total}</Text>
          </View>
          <View style={[styles.statChip, styles.statChipSuccess]}>
            <Text style={styles.statLabelSuccess}>Enrolled:</Text>
            <Text style={styles.statValueSuccess}>{stats.enrolled}</Text>
          </View>
          <View style={[styles.statChip, styles.statChipPending]}>
            <Text style={styles.statLabelPending}>Pending:</Text>
            <Text style={styles.statValuePending}>{stats.pending}</Text>
          </View>
        </View>
      </View>

      {/* Employee List */}
      {isLoading && employees.length === 0 ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#0284c7" />
          <Text style={styles.loadingText}>Loading directory...</Text>
        </View>
      ) : (
        <FlatList
          data={filteredEmployees}
          keyExtractor={(item) => item.employeeId}
          renderItem={renderEmployeeItem}
          style={styles.flatList}
          contentContainerStyle={[styles.listContent, { paddingBottom: 100 }]}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>👥</Text>
              <Text style={styles.emptyTitle}>
                {searchQuery ? 'No matching employees' : 'No employees in directory'}
              </Text>
              <Text style={styles.emptySubtitle}>
                {searchQuery
                  ? 'Try searching with a different name or employee ID'
                  : 'Add an employee profile to enroll biometric face data'}
              </Text>
              {!searchQuery && (
                <TouchableOpacity
                  style={styles.emptyAddButton}
                  onPress={() => setIsModalVisible(true)}
                >
                  <Text style={styles.emptyAddButtonText}>+ Add First Employee</Text>
                </TouchableOpacity>
              )}
            </View>
          }
        />
      )}

      {/* Add Employee Modal */}
      <Modal
        visible={isModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View
            style={[
              styles.modalCard,
              {
                maxWidth: Math.min(winWidth - 32, 480),
                maxHeight: Math.min(winHeight - 60, 580),
              },
            ]}
          >
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Add New Employee</Text>
              <TouchableOpacity
                onPress={() => setIsModalVisible(false)}
                hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.modalScrollContent}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.modalSubtitle}>
                Create basic profile then proceed to face biometric registration.
              </Text>

              {modalError ? (
                <View style={styles.modalErrorBox}>
                  <Text style={styles.modalErrorText}>⚠ {modalError}</Text>
                </View>
              ) : null}

              <Text style={styles.inputLabel}>Full Name</Text>
              <TextInput
                style={styles.modalInput}
                placeholder="e.g. Jane Doe"
                placeholderTextColor="#64748b"
                value={newFullName}
                onChangeText={(t) => {
                  setNewFullName(t);
                  setModalError('');
                }}
                autoFocus={true}
              />

              <Text style={styles.inputLabel}>Employee ID</Text>
              <TextInput
                style={styles.modalInput}
                placeholder="e.g. EMP-1049"
                placeholderTextColor="#64748b"
                value={newEmployeeId}
                onChangeText={(t) => {
                  setNewEmployeeId(t);
                  setModalError('');
                }}
              />

              {/* Modal Primary Action Buttons */}
              <TouchableOpacity
                style={styles.saveAndRegisterButton}
                onPress={handleSaveAndRegister}
                activeOpacity={0.8}
              >
                <Text style={styles.saveAndRegisterButtonText}>
                  📸 Save & Register Face
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.saveOnlyButton}
                onPress={handleSaveOnly}
                activeOpacity={0.8}
              >
                <Text style={styles.saveOnlyButtonText}>Save Profile Only</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  topHeaderContainer: {
    backgroundColor: '#0f172a',
    alignItems: 'center',
    width: '100%',
  },
  topHeader: {
    width: '100%',
    maxWidth: 760,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    backgroundColor: '#0f172a',
  },
  searchBarContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 46,
    marginRight: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  searchIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 15,
  },
  addEmployeeButton: {
    backgroundColor: '#0284c7',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0284c7',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 3,
  },
  addEmployeeButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  statsBarContainer: {
    backgroundColor: '#0f172a',
    alignItems: 'center',
    width: '100%',
  },
  statsBar: {
    width: '100%',
    maxWidth: 760,
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexWrap: 'wrap',
    gap: 8,
  },
  statChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  statLabel: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
    marginRight: 4,
  },
  statValue: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '700',
  },
  statChipSuccess: {
    backgroundColor: 'rgba(34, 197, 94, 0.1)',
    borderColor: 'rgba(34, 197, 94, 0.3)',
  },
  statLabelSuccess: {
    color: '#4ade80',
    fontSize: 12,
    fontWeight: '600',
    marginRight: 4,
  },
  statValueSuccess: {
    color: '#22c55e',
    fontSize: 12,
    fontWeight: '700',
  },
  statChipPending: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  statLabelPending: {
    color: '#fbbf24',
    fontSize: 12,
    fontWeight: '600',
    marginRight: 4,
  },
  statValuePending: {
    color: '#f59e0b',
    fontSize: 12,
    fontWeight: '700',
  },
  flatList: {
    flex: 1,
    width: '100%',
  },
  listContent: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingBottom: 100,
  },
  employeeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 2,
  },
  avatarBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
    flexShrink: 0,
  },
  avatarText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
  },
  employeeInfoCol: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  employeeName: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 2,
  },
  employeeId: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 4,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  enrolledBadge: {
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 0.35)',
  },
  enrolledBadgeText: {
    color: '#4ade80',
    fontSize: 11,
    fontWeight: '700',
  },
  pendingBadge: {
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.25)',
  },
  pendingBadgeText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  actionsCol: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
    flexShrink: 0,
    gap: 6,
  },
  enrollFaceButton: {
    backgroundColor: '#0284c7',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  enrollFaceButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  updateFaceButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#38bdf8',
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  updateFaceButtonText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
  },
  deleteIconButton: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#334155',
  },
  deleteIconText: {
    fontSize: 14,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#94a3b8',
    marginTop: 10,
    fontSize: 14,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
  },
  emptySubtitle: {
    color: '#94a3b8',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 20,
  },
  emptyAddButton: {
    backgroundColor: '#0284c7',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
  },
  emptyAddButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '90%',
    backgroundColor: '#1e293b',
    borderRadius: 20,
    padding: 22,
    borderWidth: 1,
    borderColor: '#334155',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  modalScrollContent: {
    flexGrow: 1,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  modalTitle: {
    color: '#f8fafc',
    fontSize: 20,
    fontWeight: '800',
  },
  modalCloseText: {
    color: '#94a3b8',
    fontSize: 20,
    fontWeight: '700',
    padding: 4,
  },
  modalSubtitle: {
    color: '#94a3b8',
    fontSize: 13,
    marginBottom: 16,
  },
  modalErrorBox: {
    backgroundColor: '#7f1d1d',
    borderColor: '#ef4444',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 14,
  },
  modalErrorText: {
    color: '#fecaca',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  inputLabel: {
    color: '#cbd5e1',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  modalInput: {
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  saveAndRegisterButton: {
    backgroundColor: '#0284c7',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 10,
    shadowColor: '#0284c7',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  saveAndRegisterButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  saveOnlyButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#475569',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  saveOnlyButtonText: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: '600',
  },
});
